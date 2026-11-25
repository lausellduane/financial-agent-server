# Change: Move the local builder's publish into its own job (server PR #13)

> **Status: DRAFT for Duane's approval.** Prepared Nov 24, 2026 from the code review of
> [PR #13](https://github.com/lausellduane/financial-agent-server/pull/13) at `1ee78fb`.
> Nothing is applied until Duane merges this folder to `master`. The work then lands on the PR #13 branch
> (`chore/local-builder-workflow`) through an `@claude` comment on PR #13, per the
> [Existing-PR fixes](../../../docs/openspec-workflow.md#existing-pr-fixes) path.
> This change explicitly allows edits to `.github/workflows/local-builder.yml` and `.github/scripts/local-builder*.ps1`.

## Why

Today one job on the self-hosted Windows runner does everything: it runs Aider, then runs `npm test` and
`npx tsc --noEmit` on the code the model wrote (in the aider, evaluate, and guard steps), and then publishes
with `GH_TOKEN`, which has `contents`, `pull-requests`, and `issues` write.

Code that runs in a step can write to that job's command files (`GITHUB_ENV`, `GITHUB_PATH`, and later steps'
`GITHUB_OUTPUT`). Those changes apply to every later step in the same job. So model-written code that runs
during `npm test` can poison the publish step before it gets the token. For example, it can put a fake
`powershell.exe` or `git.exe` first on `PATH`, or set `PSModulePath` or `GIT_*` variables. A background process
left running by the tests is a second way in, because it is still alive when publish starts.

Commit `1ee78fb` hardened git itself: no hooks, no fsmonitor, no global config, a `.git` integrity snapshot,
and a lease-guarded push. That was the right short-term fix, but nothing inside one job can stop environment
poisoning of later steps. The structural fix is to never put a write token in a job that runs model-written code.

GitHub documents that `GITHUB_ENV` and `GITHUB_PATH` affect only later steps **in the same job**, and a
`GITHUB_TOKEN` is minted per job with that job's `permissions`. A separate job on a fresh GitHub-hosted runner
therefore can't be reached by either attack.

## What Changes

The workflow becomes four jobs. Only the self-hosted job runs model-written code, and it gets no write token.

1. **`start`** (`ubuntu-latest`, `issues: write`). It has the owner-only `if:` guard. It parses the change ID and
   `tasks:` line from the event payload, swaps `local-builder` for `local-builder-running` on the issue, and
   records the job start time. It runs no repo code.
2. **`build`** (`[self-hosted, windows, local-builder]`, `contents: read` only). Pre-flight, checkout of
   `github.sha`, Aider attempts, evaluate, and guard work as they do today. It ends by uploading two artifacts:
   - `local-builder-result`: a manifest and the full new contents of each changed allowed file (on success only).
   - `local-builder-report`: the failure reason, `BLOCKED.md` text, and a log excerpt (always).
   It never pushes, comments, or labels.
3. **`publish`** (`ubuntu-latest`, `needs: [start, build]`, only when `build` succeeded; `contents: write`,
   `pull-requests: write`, `issues: write`). It treats the artifact as **untrusted data**:
   - It checks out `github.sha`, which is trusted and is the same base `build` used.
   - It re-derives the change ID, task numbers, and allowed file list itself from the event payload and from
     `tasks.md` at that base.
   - It validates the manifest against those rules, writes the files, and checks the resulting git diff again.
   - It commits, does the lease-guarded push, and opens or reuses the PR (ported from `local-builder.ps1`).
   - It never runs `npm`, `node`, tests, or any file from the artifact.
4. **`report`** (`ubuntu-latest`, `issues: write`, runs `if: always()` when `start` ran and `build` or `publish`
   did not succeed). It posts the failure comment and the `local-builder-failed` label. Comment text from the
   `build` artifact is sanitized and size-capped.

Also:

- `.github/scripts/local-builder.ps1` loses the `publish` step and the `.git` integrity snapshot. A new
  `-Step package` writes the artifact. A new script, `.github/scripts/local-builder-publish.ps1`, holds the publish
  and validation logic (the path guards are shared, so `build` and `publish` use the same rules).
- `.github/scripts/local-builder.tests.ps1` drops the integrity checks and gains artifact-tampering cases.
  It runs on `pwsh`, so it covers both scripts.

## Impact

- **Affected spec:** `local-builder`. The least-privilege requirement is modified, and new requirements are
  added for job separation, untrusted artifacts, and failure reporting.
- **Affected code:** `.github/workflows/local-builder.yml`, `.github/scripts/local-builder.ps1`,
  `.github/scripts/local-builder-publish.ps1` (new), and `.github/scripts/local-builder.tests.ps1`.
  No app code.
- **Cost:** still $0. The three new jobs run for a minute or two on GitHub-hosted runners, which are free on
  public repositories.
- **Behavior Duane sees:** the same labels, comments, branch name, PR title, label, and stats block. The PR still
  opens as `github-actions[bot]`, and CI still waits for "Approve workflows to run".
- **Base commit:** `build` checks out `github.sha`, the default-branch commit when the label was added, instead
  of re-fetching `origin/master` mid-job. That is still "fresh master" for a relabel retry (see design.md §4).
- **Recommended defaults:** design.md §10 lists five defaults (base commit, `build` permissions, npm cache
  follow-up, artifact visibility, size limits). Merging this folder accepts them.

## Acceptance criteria

- [ ] The `build` job's `permissions` block is exactly `contents: read`. No step in `build` references
      `github.token`, `secrets.`, or `GH_TOKEN`.
- [ ] Only `start`, `publish`, and `report` hold write scopes, and each runs on `ubuntu-latest`.
- [ ] `publish` and `report` read nothing from `needs.build.outputs`. They use only `needs.build.result` and the
      downloaded artifacts.
- [ ] `publish` rejects a tampered artifact: a path not in the re-derived allowed list, a forbidden or unsafe
      path, `..` or absolute paths, an oversize file or manifest, a wrong base sha, extra unlisted files in the
      artifact, or stats values outside their fixed sets. On rejection it pushes nothing, and `report` comments.
- [ ] `publish` runs no `npm`, `npx`, `node`, or test command, and executes nothing from the artifact.
- [ ] The failure comment still appears, with the reason and a log excerpt, for: Ollama down, bad change ID,
      oversized task, `BLOCKED.md`, no diff, guard failure, Aider timeout, and a `publish` rejection.
- [ ] The harness passes on `pwsh` with the new cases. The `.git` integrity checks are removed with the code
      they tested.
- [ ] Every step in every job has `timeout-minutes`, and every step except the Aider attempts uses 10 or less.
- [ ] PR #13's acceptance criteria still pass, with the changes listed in design.md §9.
- [ ] Code Reviewer reviews, QA tests against these criteria, and Duane merges.
