# Cloudflare Workers spike

**Recommendation: run this API on Workers Paid, and do not treat the current process as production-ready.** Express 5 can serve this app on the Workers runtime. A local `wrangler dev` session already served health, CSV upload, and a non-model query. Shipping it still requires a Durable Object for the uploaded ledger and an external Ollama host. The Workers Free plan cannot run this stack. The Expo UI stays a client; Workers Static Assets can host a web export later, and the native apps cannot run there at all.

This spike did not deploy. There is no Cloudflare API token in this environment.

## What this server is

`financial-agent-server` is one TypeScript file, `server.ts`. It is Express 5 on port 4000.

| Route | Caller | Behavior |
| --- | --- | --- |
| `POST /api/upload` | multipart field `file` | Parse a bank CSV and keep every row in a module-level array |
| `POST /api/query` | JSON `{ "question": "..." }` | Filter those rows in process. Some questions call Ollama |
| `GET /api/health` | added for this spike | `{ "ok": true, "runtime": "node" \| "cloudflare-workers" }` |

The companion UI (`lausellduane/financial-agent-ui`, Expo 57 / React Native) posts to those two routes and reads `count` from the upload response and `answer` or `error` from the query response. `App.tsx` hardcodes the base URL: `http://localhost:4000` on web and iOS, `http://10.0.2.2:4000` on the Android emulator. It sends no auth header and no session id. The web build needs CORS. Native builds do not.

Ollama is called with `ollama.chat` (model `llama3.1:latest` unless `OLLAMA_MODEL` is set). Category questions such as "how much did I spend on groceries?" classify unknown merchants in batches of 70, one HTTP call per batch, then another call can answer a free-form question. Simple questions such as "what was my highest charge?" never call the model. Responses are a single JSON body. The server does not stream.

## Can it run on the Workers runtime?

Yes, with the adapter in `worker.ts`. Workers has no listening socket. `httpServerHandler` from `cloudflare:node` takes the in-memory Node server that `app.listen(4000)` creates and routes the isolate's `fetch` event to it. That is the supported Express path: [Deploy an Express.js application](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/) and [`node:http`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/).

`npm start` (`tsx server.ts`) is unchanged for a local Node process. The Worker entry is separate so Node never imports `cloudflare:node`.

### `nodejs_compat` is not the whole story

`wrangler.jsonc` sets `compatibility_date` to `2026-11-04`. On dates on or after **2026-08-04**, Workers enables the Node.js compatibility layer by default. A new config should omit the `nodejs_compat` flag. It does not unlock extra APIs on this date.

On older dates the flag is required, and it is still not sufficient by itself:

| API this server needs | Available when |
| --- | --- |
| `process.env` from Wrangler vars and secrets | compatibility date on or after 2025-04-01 |
| `node:http` / `node:https` client | `nodejs_compat` and date on or after 2025-08-15 (or `enable_nodejs_http_modules`) |
| `http.createServer` / Express `listen` | date on or after 2025-09-01 (or `enable_nodejs_http_server_modules`) |
| `node:fs` | date on or after 2025-09-01 (or `enable_nodejs_fs_module`) |

`node:fs` on Workers is an in-memory virtual filesystem, documented at [`node:fs`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/). `/tmp` is the only writable directory. It is empty at the start of each request, it is not shared with any other request, and it counts toward the 128 MB memory limit. There is no disk.

Two runtime gaps showed up while bringing the process up:

- The Worker bundle does not set `import.meta.url`. `fileURLToPath(import.meta.url)` threw at startup. `server.ts` now skips that when the URL is missing. Node still gets a real `__dirname`.
- Multer's disk engine is the wrong upload path on Workers. It reported a file under `/tmp/uploads/...` and the following read got `ENOENT`, because that virtual file does not survive the way a Node temp file does. On Workers the CSV is kept with `multer.memoryStorage()` and parsed from the buffer. Node still writes the upload next to `server.ts` and deletes it after reading, which is the Windows path the server already depended on.

### Dependencies

| Package | On Workers |
| --- | --- |
| `express` 5, `cors` | Runs through `httpServerHandler`. Local response included `X-Powered-By: Express` and `Access-Control-Allow-Origin: *`. |
| `multer` 2 | Use memory storage. Disk storage targets a filesystem the runtime does not keep. |
| `csv-parser` | Works. It is a Node stream transform. The proof parsed a 3-row CSV from a buffer. |
| `ollama` 0.6.3 | The package's Node entry imports `node:fs` only to read image files. This server imports `ollama/browser`, which uses global `fetch`. The default host is `http://127.0.0.1:11434`. Inside a Worker that address is the isolate, not a machine running Ollama. Set `OLLAMA_HOST` to an HTTPS endpoint Cloudflare can reach. |
| `dotenv` | Listed in `package.json` and not imported. Leave it that way. Workers injects vars and secrets into `process.env`. A `.env` file is not on the virtual disk. |

Nothing here needs a native add-on. The dry-run bundle is **1682.10 KiB uncompressed** (gzip 383.80 KiB). The platform limit is **64 MiB uncompressed** on Free and Paid ([Limits](https://developers.cloudflare.com/workers/platform/limits/)). Bundle size is not a blocker. Wrangler 4.157.0 produced that bundle with `npm run check:worker`.

## Secrets, variables, and storage

### Variables and secrets

Names only. No values belong in the repo, in `wrangler.jsonc`, or in CI logs.

| Name | Kind | Required | Purpose |
| --- | --- | --- | --- |
| `OLLAMA_HOST` | Worker secret | yes, before any model query | Base URL of an Ollama-compatible API. The client adds `http://` and port `11434` when the value omits them. |
| `OLLAMA_API_KEY` | Worker secret | only if that host requires a bearer token | Sent as `Authorization: Bearer …`. The Ollama client also reads this name for `https://ollama.com`. |
| `OLLAMA_MODEL` | var in `wrangler.jsonc` | no | Defaults to `llama3.1:latest`. |
| `CORS_ORIGIN` | var, or secret if the origin should stay out of git | no | One allowed browser origin. When unset, CORS stays open (`*`), which matches today's server. Set it when a browser UI calls the deployed Worker. |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | yes for deploy | Custom token with **Edit Cloudflare Workers**, scoped to this account. |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secret | yes for deploy | Account that owns the Worker. |

Local Worker dev reads secrets from `.dev.vars` (gitignored). `.dev.vars.example` lists the names. Create the real secrets once:

```bash
npx wrangler secret put OLLAMA_HOST
npx wrangler secret put OLLAMA_API_KEY
```

`process.env` sees both vars and secrets when the compatibility date is on or after 2025-04-01, which this config is.

### Where the ledger should live

Today every parsed row sits in `let transactionData` in the module. That array lives only in the isolate that handled the upload. A later request can land on a different isolate, and a cold start drops it. The UI would then get `Please upload a transaction report first.` The proof below kept the rows only because `wrangler dev` is one local process.

Use a **Durable Object** for the ledger, one object for the current single-user behavior (the same global statement the process holds today). Store the parsed rows in the object's SQLite storage so an eviction keeps them. The upload and query routes forward to that object. When the product grows past one statement at a time, key the object by a session id and have the UI send that id. The UI does not send one today.

| Store | Role for this app |
| --- | --- |
| Durable Object | The ledger. Matches the current "one array, then filter it in JavaScript" model, and it survives isolate eviction. |
| R2 | Optional archive of the original CSV. The request path does not need it. Parse during the upload and discard the bytes. |
| D1 | A later fit if queries move into SQL or statements are shared across users. Moving there means rewriting the in-memory filters. It is not required to match today's behavior. |
| KV | A poor ledger. Values are size-capped (25 MiB), reads are eventually consistent, and every upload would rewrite one blob. |
| Workers `/tmp` | Scratch space for a single request. Confirmed not durable enough for Multer's temp file. |

Ollama stays **outside** Cloudflare. Workers cannot run the Llama binary, and waiting on it is network time rather than a database.

## Wrangler config

`wrangler.jsonc` is the whole config:

- `name`: `financial-agent-server`
- `main`: `worker.ts`
- `compatibility_date`: `2026-11-04`
- `vars.OLLAMA_MODEL`: `llama3.1:latest`
- `limits.cpu_ms`: `30000` (Paid default). This is enforced on Cloudflare's network only. `wrangler dev` ignores it.

No D1, KV, or R2 bindings yet. Add a Durable Object binding when the ledger moves.

## GitHub Actions

DevOps owns the workflow. Outline only; this repo does not add a workflow file. The default branch is `master`. There is no separate compile step. Wrangler bundles `worker.ts`.

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
          OLLAMA_HOST: ${{ secrets.OLLAMA_HOST }}
          OLLAMA_API_KEY: ${{ secrets.OLLAMA_API_KEY }}
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
          secrets: |
            OLLAMA_HOST
            OLLAMA_API_KEY
```

The action installs Wrangler and runs from the repo root. Pinning comes from the `wrangler` devDependency (`^4.157.0`). Official reference: [GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/). The token needs **Edit Cloudflare Workers** on this account only.

`command: deploy` publishes the Worker. The `secrets` input reads the matching environment variables and stores them as Worker secrets, so the values stay in GitHub Actions secrets and off the runner logs as far as the action's own masking goes. Do not `echo` them. Re-deploying `vars` from `wrangler.jsonc` updates `OLLAMA_MODEL`. Add `--keep-vars` only if someone also sets variables in the dashboard and those must survive a deploy.

## Blockers

| Topic | Result |
| --- | --- |
| CPU time | **Free plan is a blocker.** Free allows 10 ms of CPU per request. Paid allows 30 seconds by default and up to 5 minutes via `limits.cpu_ms`. CSV parsing and the keyword tables are CPU. Waiting on Ollama is not: network time is excluded. A normal statement fits in the Paid default. A very large file could need a higher `cpu_ms` or to be parsed in smaller pieces. This config keeps the 30 second default. |
| Wall clock and streaming | **No hard cap on an HTTP request** while the client stays connected ([Limits](https://developers.cloudflare.com/workers/platform/limits/)). This server does not stream. A groceries-style question can issue several sequential Ollama calls and the UI waits for one JSON body. A slow model can outlast a phone OS or a proxy even though Workers will keep the request open. Runtime updates give in-flight requests up to about 20 minutes to finish, then drop them. Design those calls so the client can retry. |
| Subrequests | One Ollama call is one subrequest. Free allows 50 per request, Paid 10,000. Batches of 70 merchants stay under the Free cap for a normal export. Paid is required anyway because of CPU. Outgoing connections are capped at 6 at once; this code calls Ollama one at a time, so that cap is idle. |
| Bundle size | 1.6 MiB uncompressed. Limit 64 MiB. Not a blocker. |
| Memory | 128 MB. The upload buffer plus the parsed rows have to fit. A bank CSV does. The cap matters only for a very large file. |
| Cold start | The meaningful failure is **loss of `transactionData`**, not boot time. Worker startup must finish within 1 second. This bundle is small enough that startup itself is not the risk. The first local `GET /api/health` completed in 35 ms of wall clock under `wrangler dev` (dev overhead included, not a production CPU measurement). |
| Unsupported packages | No native modules. `dotenv` must stay unused. Ollama's default localhost host does not work. The Node entry of `ollama` is the wrong import; `ollama/browser` is the one wired up. |
| Local model | **Product blocker.** The UI copy and the server both assume a loopback Llama. A Worker can only call an Ollama host that is reachable from Cloudflare's edge. A laptop on localhost is not. Merchant strings from the statement are sent to that host. The CSV itself transits Cloudflare. That is a different privacy boundary than "parsed locally on Windows." |
| UI hosting | The UI is Expo, with web, Android, and iOS. Workers Static Assets (or Pages, for an existing Pages project) can host an `expo export --web` build. They cannot run the iOS or Android app. The web client still has to stop hardcoding `localhost:4000`. This spike does not change the UI repo. |

## Proof of concept

Commands:

```bash
npm ci
npm run check:worker   # wrangler deploy --dry-run --outdir dist
npm run dev:worker     # http://localhost:8787
npm start              # Node, http://localhost:4000
```

`npm run check:worker` completed with Wrangler 4.157.0: **Total Upload: 1682.10 KiB / gzip: 383.80 KiB**. It does not contact the Cloudflare API.

Against `wrangler dev` on `127.0.0.1:8787`:

- `GET /api/health` → `200` `{"ok":true,"runtime":"cloudflare-workers"}`
- `POST /api/upload` with a 3-row CSV → `200`, `count: 3`, merchants Chipotle, Piedmont Natural Gas, and Costco
- `POST /api/query` `{"question":"What was my highest charge?"}` → `200` `Costco: $86.20`
- `POST /api/upload` with no file → `400` `{"error":"No file uploaded"}`

The same upload and highest-charge query against `npm start` returned the same Costco answer, and health reported `"runtime":"node"`. No model call was made. There is no Ollama server here, and `OLLAMA_HOST` was left unset on purpose.

## Deploy

Do this from a machine that has the Cloudflare credentials. This spike did not run it.

```bash
npx wrangler deploy
```

Required in the environment for a non-interactive run:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Worker secrets that must already exist (or be set in the same session) before a model query will succeed:

- `OLLAMA_HOST`
- `OLLAMA_API_KEY` when the host requires it

`CORS_ORIGIN` is optional. Set it to the browser origin of the UI before a deployed web client calls the Worker.
