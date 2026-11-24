# Change: Fix QA findings on the local builder (server PR #13)

> **Status: APPROVED by Duane Nov 24, 2026.** Prepared Nov 24, 2026 by Project Manager from QA Engineer's findings on
> [PR #13](https://github.com/lausellduane/financial-agent-server/pull/13) at `56318ff`.
> Intended as Claude's first task via the `@claude` issue form (PR #14, `67ff46f`).
> Nothing pushed, merged, or filed. No issue is opened until Duane says yes.

## Why

QA testing of PR #13 found two MEDIUM and four LOW problems in `.github/scripts/local-builder.ps1` and
`.github/workflows/local-builder.yml`. The MEDIUMs weaken the two safety promises of the local builder:
the agent must never change protected paths, and the job token must never reach code the agent wrote.

## What Changes

All work lands on the PR #13 branch (head `56318ff`), not `master`.

1. **MEDIUM – forbidden-path guard.** `Get-NormalizedPath` uses `.TrimStart('./')`, which strips every leading
   `.` and `/`. `.github/x`, `.git/config`, `.env`, `.dev.vars` become `github/x`, `git/config`, `env`, `dev.vars`,
   so `Test-ForbiddenPath` never fires, and `../escape.ts` becomes `escape.ts`.
   Fix: strip only a leading `./` (`-replace '^\./+',''`), reject any `..` segment, and make sure changes under
   `.git/` are detected and rejected.
2. **MEDIUM – token reachable from git hooks.** The publish step runs `git commit` (`local-builder.ps1:705`) with
   `GH_TOKEN` set and hooks enabled, so an agent-written hook could read the token.
   Fix: `git -c core.hooksPath=NUL commit --no-verify`, and expose `GH_TOKEN` only to the push and PR-create calls.
3. **LOW – missing step timeouts.** Add `timeout-minutes` (10 or less) to: Record start time and mark issue running,
   Parse change id, Checkout, Parse change and create branch, Commit/push/open PR, Comment on failure, Cleanup workspace.
4. **LOW – attempt 2 skipped after a timeout.** If Aider attempt 1 times out, its outcome is `cancelled`, so
   "Evaluate attempt 1" is skipped and attempt 2 never runs. Accept `cancelled` too, but still skip when `BLOCKED.md` exists.
5. **LOW – relabel retry blocked.** Once `local-builder/issue-N` exists on origin, a relabel retry fails until the
   branch is deleted by hand. Recreate the existing branch from freshly fetched `origin/master` (Duane's decision, Nov 24).
6. **LOW – guard diff base race.** `Get-ChangedFiles` diffs against local `master`, while the branch starts from a freshly
   fetched `origin/master`. Diff against the same base ref the branch was created from.

## Impact

- Affected spec: `local-builder` (hardening requirements added).
- Affected code: `.github/scripts/local-builder.ps1`, `.github/workflows/local-builder.yml`, guard tests.
- No new secrets, services, or cost. No change to financial-agent-ui.

## Acceptance criteria

- [ ] Each of the 6 fixes has a test or harness case. QA's PowerShell harness: `/workspace/qa-pr13/guardtest/guard-harness.ps1` (shared box).
- [ ] `.github/x`, `.git/config`, `.env`, `.dev.vars` are rejected as forbidden; `../escape.ts` is rejected as unsafe; `./src/a.ts` normalizes to `src/a.ts` and is allowed.
- [ ] The commit runs with hooks disabled and `--no-verify`; `GH_TOKEN` is not in the environment during commit.
- [ ] Every listed step has `timeout-minutes` of 10 or less.
- [ ] A timed-out attempt 1 (`cancelled`) leads to attempt 2 unless `BLOCKED.md` exists.
- [ ] Relabeling an issue whose branch already exists recreates `local-builder/issue-N` from fresh `origin/master` and the run proceeds.
- [ ] `Get-ChangedFiles` diffs against the same base ref the branch was created from.
- [ ] All of PR #13's original acceptance criteria still pass.
- [ ] Code Reviewer reviews, QA tests against these criteria, and Duane merges.
