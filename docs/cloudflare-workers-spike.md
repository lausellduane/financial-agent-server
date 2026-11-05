# Cloudflare Workers spike

**Recommendation: run this API on Workers Paid, behind Cloudflare Access.** The Worker verifies the `Cf-Access-Jwt-Assertion` JWT on every `/api` route, stores each person's statement in their own SQLite Durable Object, and calls Workers AI through an `AI` binding. Local Node (`npm start`) skips Access, calls Ollama, and keeps one statement in process memory. The Workers Free plan cannot run this stack. This environment has no Cloudflare token, so nothing was deployed.

## What this server is

`financial-agent-server` is Express 5. `worker.ts` is the Workers entry. `npm start` is the Node entry.

| Route | Caller | Behavior |
| --- | --- | --- |
| `POST /api/upload` | multipart field `file` | Parse a bank CSV and store every row |
| `POST /api/query` | JSON `{ "question": "..." }` | Filter those rows in process. Some questions call the model |
| `GET /api/health` | probe | Runtime, provider, model, and ledger. No row count. On Workers it requires Access like the other `/api` routes. |

The companion UI (`lausellduane/financial-agent-ui`, Expo 57 / React Native) posts to the upload and query routes and reads `count` from the upload response and `answer` or `error` from the query response. `App.tsx` hardcodes `http://localhost:4000` on web and iOS, and `http://10.0.2.2:4000` on the Android emulator. It sends no auth header and no session id. The web build needs CORS. Native builds do not.

Simple questions such as "what was my highest charge?" never call the model. Category questions such as "how much did I spend on groceries?" classify unknown merchants in batches of 70. A question that matches neither path asks the model to pick ledger rows. Responses are one JSON body. The server does not stream.

## Model

Workers AI model: `@cf/meta/llama-3.1-8b-instruct-fast`.

The cost note priced `@cf/meta/llama-3.1-8b-instruct-fp8-fast`. That id is no longer in the catalog. `@cf/meta/llama-3.1-8b-instruct` was deprecated on 2026-05-30. The `-fast` Llama 3.1 8B instruct model is still listed, with a 128,000 token window and the chat `messages` API. It matches this app's short JSON classification calls. Llama 4 Scout is also in the catalog; it is a larger model than this workload needs. The id lives only in `DEFAULT_WORKERS_AI_MODEL` in `constants.ts`. Set `WORKERS_AI_MODEL` in the environment to override it.

`LLM_PROVIDER` chooses the backend:

| Value | Who calls the model |
| --- | --- |
| `workers-ai` | `env.AI.run`. Set in `wrangler.jsonc`, so the deployed Worker uses it. |
| `ollama` | The `ollama` package, host `OLLAMA_HOST` or `http://127.0.0.1:11434`. |
| unset | Workers AI on the Workers runtime, Ollama under Node. |

Temperature is 0 on both paths. Workers AI `max_tokens` is 2048 so a long index list is not cut at the model's default of 256. Ollama text is `message.content`. Workers AI is not always `{ response: string }`: a JSON reply can come back as an object on `response`, and some models put the text on `choices[0].message.content` with `response` null. `workersAiText` accepts those, plus a `{ result: ... }` envelope and an SSE stream. The live deploy's model questions failed with "empty response" because the parser only kept a string `response`.

## Can it run on the Workers runtime?

Yes. `httpServerHandler` from `cloudflare:node` routes the isolate's `fetch` event to the Express app that `app.listen(4000)` creates. See [Deploy an Express.js application](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/) and [`node:http`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/). `npm start` does not import `cloudflare:node`.

### `nodejs_compat`

`compatibility_date` is `2026-11-04`. On dates on or after **2026-08-04** the Node.js compatibility layer is already on. Leave the `nodejs_compat` flag unset.

On older dates the flag is required, and it is still not sufficient by itself:

| API | Available when |
| --- | --- |
| `process.env` from Wrangler vars and secrets | compatibility date on or after 2025-04-01 |
| `node:http` client | `nodejs_compat` and date on or after 2025-08-15 |
| `http.createServer` / Express `listen` | date on or after 2025-09-01 |
| `node:fs` | date on or after 2025-09-01 |

`node:fs` is an in-memory virtual filesystem ([`node:fs`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)). Only `/tmp` is writable, and only for the current request.

Two gaps found while booting the app:

- The Worker bundle does not set `import.meta.url`. `fileURLToPath` is skipped when it is missing. Node still gets a real `__dirname`.
- Multer's disk engine loses the temp file on the virtual filesystem. On Workers the CSV stays in `multer.memoryStorage()`. Node still writes the upload next to `server.ts` and deletes it after reading.

### Dependencies

| Package | On Workers |
| --- | --- |
| `express` 5, `cors` | Runs through `httpServerHandler`. |
| `multer` 2 | Memory storage. Disk storage does not keep the file. |
| `csv-parser` | Works from a buffer. |
| `ollama` 0.6.3 | Used only when `LLM_PROVIDER` is `ollama`. The import is `ollama/browser` (global `fetch`). The Node entry of the package reads image files with `node:fs` and is not used. |
| `dotenv` | A dependency, and not imported. Vars and secrets arrive on `process.env`. |

The dry-run bundle is **1685.08 KiB uncompressed** (gzip 384.73 KiB). The limit is **64 MiB uncompressed** ([Limits](https://developers.cloudflare.com/workers/platform/limits/)). Wrangler 4.157.0 produced that bundle with `npm run check:worker`.

## Secrets, variables, and storage

Names only. No values belong in the repo.

| Name | Kind | Required | Purpose |
| --- | --- | --- | --- |
| `ACCESS_TEAM_DOMAIN` | secret or var | yes on Workers | Team subdomain (`your-team`) or `https://your-team.cloudflareaccess.com`. The issuer is `https://<team>.cloudflareaccess.com`. JWKS is `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. |
| `ACCESS_AUD` | secret or var | yes on Workers | AUD tag of the **UI** Access application. The browser session is that app, and the API checks the JWT it issued. |
| `CORS_ORIGIN` | var, empty in `wrangler.jsonc` | no in production | Production calls are same-origin, so this stays empty. `*` is ignored. Node dev uses `http://localhost:8081` and `http://localhost:19006` when it is empty. Set a comma-separated list only for a cross-origin dev UI. |
| `LLM_PROVIDER` | var, already `workers-ai` | no | `workers-ai` or `ollama`. |
| `WORKERS_AI_MODEL` | env override | no | Overrides `DEFAULT_WORKERS_AI_MODEL` in `constants.ts`. Not set in `wrangler.jsonc`. |
| `OLLAMA_MODEL` | var, already `llama3.1:latest` | only for the Ollama path | Node default, and the Worker if you force `LLM_PROVIDER=ollama`. |
| `OLLAMA_HOST` | secret | only for the Ollama path | Base URL. The client adds `http://` and port `11434` when the value omits them. |
| `OLLAMA_API_KEY` | secret | only if that Ollama host requires a bearer token | Sent as `Authorization: Bearer …`. |
| `CLOUDFLARE_API_TOKEN` | shell or GitHub secret | yes to deploy | **Workers Scripts: Edit**. Add **Workers AI: Read** so `wrangler dev` can call the remote AI binding. This is not an app bearer token. |
| `CLOUDFLARE_ACCOUNT_ID` | shell or GitHub secret | yes to deploy | Account that owns the Worker. |

There is no application bearer token. On Workers, a request without a valid Access JWT gets `401`. If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is missing, every `/api` route fails closed with `401`. `npm start` does not check Access.

Workers AI does not take an API key inside the Worker. The `AI` binding authenticates as the Worker.

`.dev.vars` is gitignored. `.dev.vars.example` lists the names.

### Ledger

On the Worker, parsed rows go to a SQLite Durable Object, class `Ledger`, binding `LEDGER`. The object name is `sub:<subject>` when the token has a subject, otherwise `email:<address>`. The same text as an email and as a subject is two ledgers. Service tokens (`type: "app"`) and tokens with neither claim are rejected. Upload replaces that person's rows. Inserts are batched. A CSV over 5 MB or 20,000 rows is rejected.

The earlier proof of concept keyed the object by the raw email. Those objects are orphaned. Anyone who uploaded on that deploy has to upload the statement again.

The UI's suggested native Access path can send a service token (`type: "app"`). This Worker rejects those tokens. Whoever switches the UI to native Access has to use a user JWT, or this API has to grow an explicit service-token identity. Those two choices conflict until that is decided.

Node keeps one array in the process, because Access is not checked there.

| Store | Role |
| --- | --- |
| Durable Object `LEDGER` | The ledger. Implemented. |
| R2 | Optional archive of the original CSV. The request path does not need it. |
| D1 | A later fit if the filters move into SQL. |
| KV | A poor ledger. Values are capped at 25 MiB and reads are eventually consistent. |
| Workers `/tmp` | Scratch space for one request. Not used for the CSV. |

## Wrangler config

`wrangler.jsonc`:

- `name`: `financial-agent-server`
- `main`: `worker.ts` (also exports the `Ledger` class)
- `compatibility_date`: `2026-11-04`
- `ai.binding`: `AI`, with `remote: true` so `wrangler dev` calls the real model
- `durable_objects.bindings`: `LEDGER` → `Ledger`
- `exports.Ledger`: `{ "type": "durable-object", "storage": "sqlite" }`
- `workers_dev`: false, and `preview_urls`: false. The UI reaches the API on the same origin.
- vars: `LLM_PROVIDER`, `OLLAMA_MODEL`, `CORS_ORIGIN` (`""`). The Workers AI model id is `DEFAULT_WORKERS_AI_MODEL` in `constants.ts`.
- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are not in the file. DevOps sets them as secrets or vars. `ACCESS_AUD` is the UI Access application's AUD tag.
- `limits.cpu_ms`: `30000` (Paid default). Enforced on Cloudflare's network only.

`npx wrangler dev` with `remote: true` opens a remote proxy at startup. Without `CLOUDFLARE_API_TOKEN` that startup fails before the server listens. `npx wrangler dev --local` disables remote bindings, serves the Durable Object, and rejects `env.AI.run` with `Binding AI needs to be run remotely`.

## GitHub Actions

DevOps owns the workflow. This repo does not add one. The default branch is `master`. Wrangler bundles TypeScript. There is no separate compile step. Outline for when they add it, including the Access secrets. Add `OLLAMA_HOST` and `OLLAMA_API_KEY` only if `LLM_PROVIDER` is `ollama`. Reference: [GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

```yaml
name: Deploy Worker
on:
  push:
    branches: [master]
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v6
      - name: Deploy
        uses: cloudflare/wrangler-action@v4
        env:
          ACCESS_TEAM_DOMAIN: ${{ secrets.ACCESS_TEAM_DOMAIN }}
          ACCESS_AUD: ${{ secrets.ACCESS_AUD }}
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
          secrets: |
            ACCESS_TEAM_DOMAIN
            ACCESS_AUD
```

## Blockers

| Topic | Result |
| --- | --- |
| CPU time | **Free plan is a blocker.** Free allows 10 ms of CPU per request. Paid allows 30 seconds by default and up to 5 minutes. Parsing and the keyword tables are CPU. Waiting on Workers AI is not. This config keeps 30 seconds. |
| Wall clock | No hard cap on an HTTP request while the client stays connected. A category question can call the model several times, and the UI waits for one JSON body. A slow reply can outlast a phone even though Workers keeps the connection open. |
| Workers AI locally | `wrangler dev` refuses to start the remote AI proxy without `CLOUDFLARE_API_TOKEN`. `wrangler dev --local` reaches `env.AI.run` and returns `Binding AI needs to be run remotely`. The first live deploy did call the model; questions failed until `workersAiText` accepted a parsed JSON `response` and a `choices` message. |
| Bundle size | 1.6 MiB uncompressed. Limit 64 MiB. |
| Memory | 128 MB for the isolate. The Durable Object holds the statement outside that heap. |
| Cold start | The statement survives isolate eviction. Startup itself must finish within 1 second. This bundle is small enough that the limit is not the risk. |
| Auth | Workers require a Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) checked against the team JWKS, with `iss`, `aud`, and `exp`. The ledger id is that identity. Node dev skips the check. DevOps still creates the Access application in front of the hostname so browsers receive the cookie and header. |
| Privacy | The CSV transits Cloudflare, and merchant strings are sent to Workers AI on the same account. That is a different boundary than a loopback Llama. The UI still says the model is local and still hardcodes `localhost:4000`. It does not send the Access JWT yet. |
| UI hosting | Expo web can later sit on Workers Static Assets. The iOS and Android apps cannot. This change does not touch the UI repo. |

## Tests

`npm test` runs the Node unit tests (`workersAiText`, `parseCsv`) and the Workers runtime tests in `test/api.spec.ts`. Those use `@cloudflare/vitest-plugin`, the current name of the Workers Vitest pool. The older `@cloudflare/vitest-pool-workers` package's workerd cannot start this Worker's compatibility date. The pool tests cover health, upload, a non-model query, a rejected JWT, a missing Access config, the 5 MB and 20,000-row caps, and two Access identities not sharing a ledger.

## Proof

```bash
npm ci
npm run check:worker   # wrangler deploy --dry-run --outdir dist
npm run dev:worker     # needs CLOUDFLARE_API_TOKEN because AI is remote
npx wrangler dev --local --port 8787
npm start              # Node, http://localhost:4000
```

`npm run check:worker` with Wrangler 4.157.0:

```text
Total Upload: 1685.08 KiB / gzip: 384.73 KiB
env.LEDGER (Ledger)     Durable Object
env.AI                  AI
env.LLM_PROVIDER        workers-ai
env.WORKERS_AI_MODEL    @cf/meta/llama-3.1-8b-instruct-fast
```

`wrangler dev` without a token stopped at: `In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN`.

`wrangler dev --local` on `127.0.0.1:8787`:

- `GET /api/health` → `llm: "workers-ai"`, `model: "@cf/meta/llama-3.1-8b-instruct-fast"`, `ledger: "durable-object"`, `rows: 0`
- `POST /api/upload` of a 3-row CSV → `200`, `count: 3`
- `POST /api/query` `{"question":"What was my highest charge?"}` → `Costco: $86.20`
- After stopping and starting `wrangler dev --local` again, health reported `rows: 3` and the same query returned Costco without another upload
- A free-form question that calls the model → `500`, log: `Binding AI needs to be run remotely` at `env.AI.run`

`npm start`:

- health → `llm: "ollama"`, `model: "llama3.1:latest"`, `ledger: "memory"`
- the same upload and highest-charge query returned Costco

## Deploy from another machine

From a checkout of this branch:

```bash
npm ci
export CLOUDFLARE_API_TOKEN="..."   # Workers Scripts: Edit, plus Workers AI: Read
export CLOUDFLARE_ACCOUNT_ID="..."
npx wrangler secret put ACCESS_TEAM_DOMAIN   # team subdomain, or https://<team>.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD           # AUD tag of the UI Access application
npx wrangler deploy
```

Put Cloudflare Access on the UI, not on a separate API hostname. `ACCESS_AUD` is that UI application's AUD tag. The browser sends `Cf-Access-Jwt-Assertion` on the same origin. The Worker checks the signature, `iss`, `aud`, `exp`, and `iat`, with 30 seconds of clock skew. A request without a valid user token gets `401`, including when the two Access settings are missing. Service tokens are rejected.

`workers.dev` and preview URLs are off. `CORS_ORIGIN` is empty because those calls are same-origin. Node dev still allows localhost and sends `Access-Control-Allow-Credentials`. Do not set `CORS_ORIGIN` to `*`.

Wrangler prints the `workers.dev` URL. Health, upload, and query need the Access JWT header:

```bash
curl -H "Cf-Access-Jwt-Assertion: $TOKEN" \
  https://financial-agent-server.<account-subdomain>.workers.dev/api/health
```

Expect `"llm":"workers-ai"` and `"ledger":"durable-object"`, and no `rows` field.

To exercise the model before deploy, with the API token and account id exported, and the two Access secrets in `.dev.vars`:

```bash
npx wrangler dev
```

`remote: true` on the `AI` binding sends those calls to the account. `npx wrangler dev --local` does not.

Optional, only to put the Worker back on Ollama: set `LLM_PROVIDER` to `ollama`, then:

```bash
npx wrangler secret put OLLAMA_HOST
npx wrangler secret put OLLAMA_API_KEY
```
