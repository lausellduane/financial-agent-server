# Tasks: fix-local-builder-qa-findings

> Work on the PR #13 branch only. Never push to `master`. Nothing starts until Duane approves.

## 1. Forbidden-path guard (MEDIUM)
- [ ] 1.1 In `Get-NormalizedPath`, replace `.TrimStart('./')` with `-replace '^\./+',''` (after `\` to `/` and Trim).
- [ ] 1.2 Reject any `..` path segment in the guard path (keep `Test-SafeRelPath` check; make sure it sees the un-stripped path).
- [ ] 1.3 Ensure changes under `.git/` are detected and rejected.
- [ ] 1.4 Harness cases: `.github/x`, `.git/config`, `.env`, `.dev.vars` forbidden; `../escape.ts` unsafe; `./src/a.ts` -> `src/a.ts` allowed.

## 2. Token isolation from git hooks (MEDIUM)
- [ ] 2.1 Change the publish commit to `git -c core.hooksPath=NUL commit --no-verify -m $msg`.
- [ ] 2.2 Remove `GH_TOKEN` from the environment during commit; set it only for the push and the PR-create call.
- [ ] 2.3 Test: a planted `.git/hooks/pre-commit` that writes `$env:GH_TOKEN` does not run and nothing is leaked.

## 3. Step timeouts (LOW)
- [ ] 3.1 Add `timeout-minutes` (<= 10) to: Record start time and mark issue running, Parse change id, Checkout, Parse change and create branch, Commit/push/open PR, Comment on failure, Cleanup workspace.
- [ ] 3.2 Check: a lint/grep test asserts every step in `local-builder.yml` has `timeout-minutes`.

## 4. Attempt 2 after timeout (LOW)
- [ ] 4.1 Change the "Evaluate attempt 1" condition to also accept `steps.aider1.outcome == 'cancelled'`.
- [ ] 4.2 Still skip attempt 2 when `BLOCKED.md` exists.
- [ ] 4.3 Test or harness case for the `cancelled` path.

## 5. Relabel retry (LOW)
- [ ] 5.1 When `local-builder/issue-N` already exists on origin, recreate that branch from freshly fetched `origin/master` (decided by Duane, Nov 24).
- [ ] 5.2 Test or harness case for an existing branch.

## 6. Guard diff base (LOW)
- [ ] 6.1 Record the base ref used to create the branch (fresh `origin/master`) and diff `Get-ChangedFiles` against it.
- [ ] 6.2 Test or harness case where local `master` is behind `origin/master`.

## 7. Verify
- [ ] 7.1 Run QA's harness `/workspace/qa-pr13/guardtest/guard-harness.ps1` and the repo tests; all pass.
- [ ] 7.2 Confirm PR #13's original acceptance criteria still pass.
- [ ] 7.3 Push to the PR #13 branch (with Duane's yes), then Code Reviewer re-reviews and QA retests.
