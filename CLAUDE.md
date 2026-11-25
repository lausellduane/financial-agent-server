# CLAUDE.md

Standing rules for Claude Code (and any `@claude` coding worker) in this repository.

## OpenSpec workflow

The human-facing process (explore, interview, propose, apply, archive) is in [`docs/openspec-workflow.md`](docs/openspec-workflow.md). Follow the **Stage** on the issue, or an `@claude` comment on an already-open PR, as follows.

- **Explore:** Run `/opsx:explore` (or the equivalent). Make no repo changes: no commits, branches, change folders, or pull requests. Post findings and a numbered list of open questions or decisions as an issue comment, then stop.
- **Propose:** Only after Duane's answers are posted on the issue. Run `/opsx:propose` (or the equivalent). Open a pull request that adds only `openspec/changes/<change-id>/`. No application code.
- **Apply:** Work only from an approved OpenSpec change folder on `master`. Do not invent a change, and do not start from a proposal that Duane has not approved. Prefer archiving the change (`openspec/changes/archive/` plus updated `openspec/specs/`) in the same code PR.
- **Existing-PR fix:** If `@claude` is commented on an already-open pull request, work on that PR's branch. Do not open a new branch from `master` for that request.

## Work from an approved OpenSpec change

For Apply (and for any coding work that is not Explore or Propose), work only from an approved OpenSpec change folder.

OpenSpec layout (added in PR #12):

- `docs/openspec-workflow.md` — end-to-end workflow with Claude and approval gates.
- `openspec/README.md` — short index for this layout.
- `openspec/changes/<change-id>/` — a proposed change. A typical folder has `proposal.md`, `design.md`, `tasks.md`, and `specs/`. Some changes also include `conventions/` or `prompts/`.
- `openspec/specs/` — accepted specs, filled in as changes are archived.

A change counts as approved once Duane approves it and the change folder is on `master` (see `openspec/README.md`).

For the assigned apply change:

1. Read the folder's `proposal.md`, `design.md`, and any specs or conventions in that folder.
2. Follow that folder's `tasks.md` in order. Do not skip ahead.
3. Tick tasks off in `tasks.md` as you complete them (`- [ ]` → `- [x]`). Leave tasks that are marked for Duane, or that you cannot do, unchecked, and say so on the issue or PR.

PR #13 (local builder workflow) may land separately. That path is a Windows self-hosted Aider job, not this Claude Code worker. Do not treat its `BLOCKED.md` convention as the stuck-procedure here unless the approved change says to. Do not edit that workflow unless the change explicitly says to.

## PR-only

- Open a pull request against `master`.
- Never merge, never approve a pull request, never push to `master` or `main`, never force-push, and never deploy.
- Never change repository secrets. You may create, edit, and commit files under `.github/workflows/` when the user request or an approved OpenSpec change requires it.

## If you are stuck

If a requirement is unclear, or you are blocked, comment on the issue or pull request and stop. Do not guess.

## Models and tests

- Do not make live AI or model calls in tests. Inject fakes or stubs (see `llm.test.ts` and `setCompleteChatForTests` in `llm.ts`).
- Leave model defaults unchanged unless the approved change explicitly says to change them. That includes `LLM_PROVIDER`, `OLLAMA_MODEL`, `WORKERS_AI_MODEL` / `DEFAULT_WORKERS_AI_MODEL` (`@cf/meta/llama-3.1-8b-instruct-fast`), `WORKERS_AI_TEMPERATURE` (0), `WORKERS_AI_MAX_TOKENS` (2048), and the wrangler `ai` binding.

## Stack

This is the API for a personal finance agent. There is a Node/Express listener and a Cloudflare Worker that share most of the TypeScript modules.

- **Runtimes:** Node (Express in `server.ts`, default port 4000) and Cloudflare Workers (`worker.ts`). CI uses Node 22. The Worker is a paid-plan Durable Object app (`Ledger`, SQLite storage) with a Workers AI binding. `wrangler.jsonc` sets `workers_dev` and `preview_urls` to false; the UI calls this Worker through a same-origin service binding.
- **Language:** TypeScript ESM (`"type": "module"` in `package.json`, `module`/`moduleResolution` `nodenext` in `tsconfig.json`). Import local files with a `.js` specifier in production modules (for example `import { onWorkers } from "./access.js"`). Tests often import `.ts` sources directly.
- **App code:** CSV upload and statement parsing, a ledger, category rules (`CATEGORY_RULES_VERSION` in `categories.ts`), spend/income totals, and a question-answering path that calls an LLM. The model provider is Workers AI on Workers and Ollama on Node, unless `LLM_PROVIDER` overrides it.
- **Auth:** Cloudflare Access JWT checks in `access.ts`. Local Worker secrets are named in `.dev.vars.example`; do not commit `.dev.vars` or real secret values.
- **Tooling:** `tsx`, `typescript`, `vitest` with `@cloudflare/vitest-plugin`, and `wrangler`. There is no ESLint or Prettier config in this repo.

Useful scripts and commands (from `package.json` and CI):

- `npm start` — run the Node server (`tsx server.ts`).
- `npm run dev:worker` — `wrangler dev`.
- `npm test`, `npx tsc --noEmit`, and `npm run check:worker` — see below.

## Test commands

Run these from the repo root after `npm ci` (or `npm install`). CI (`Test` in `.github/workflows/deploy-poc.yml`) runs all three, in this order:

```bash
npm test
npx tsc --noEmit
npm run check:worker
```

- `npm test` runs the Node tests first, then the Workers tests:
  - Node: `tsx --test` on `workers-ai-text.test.ts`, `parse-csv.test.ts`, `llm.test.ts`, `indexes.test.ts`, `monthly-spend.test.ts`, `spend-cents.test.ts`, and `node-spend.test.ts`.
  - Workers: `vitest run`, which loads `vitest.config.ts` and the specs in `test/` (`test/api.spec.ts`, `test/spend.spec.ts`).
- `npx tsc --noEmit` is the typecheck. There is no `typecheck` npm script; this is the command CI uses. `tsconfig.json` is `strict` (plus `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`) and excludes `node_modules`, `dist`, `test`, and `**/*.test.ts`.
- `npm run check:worker` is `wrangler deploy --dry-run --outdir dist`. It bundles the Worker and validates `wrangler.jsonc` without publishing and without Cloudflare credentials.

All three must pass before you open a PR, unless the approved change says a command does not apply. If you add a Node test file, also add it to the `tsx --test` list in the `test` script.

## Code style

Match the file you are editing. Do not reformat unrelated code, and do not add a linter or formatter unless the change says to.

- TypeScript, 2-space indent, double quotes, semicolons.
- `verbatimModuleSyntax` is on: use `import type` for type-only imports.
- Prefer named exports, `const` types, and early returns. Keep comments short and only where they explain a non-obvious rule.
- New tests should follow the nearest existing test file: `node:test` plus `node:assert/strict` for Node tests, Vitest (`describe` / `it` / `expect`) for Workers tests. Stub LLM calls; do not hit a live model.
