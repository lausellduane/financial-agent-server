# Tasks: split-local-builder-publish-job

> - Work on the PR #13 branch (`chore/local-builder-workflow`) only. Never push to `master`.
> - This change allows edits to `.github/workflows/local-builder.yml` and `.github/scripts/local-builder*.ps1`.
> - **[Duane]** = Duane does it on the PC or in GitHub.
> - Built on Nov 24, 2026 in PR #13 commit `960c5f4`, at Duane's direct request. "As built" notes mark where the
>   code differs from the original plan.

## 1. Shared path rules
- [x] 1.1 Move `Get-NormalizedPath`, `Test-SafeRelPath`, `Test-ForbiddenPath`, `Test-AiderArtifact`, `Get-TaskBlocks`, and `Get-FilesFromTaskBody` into `.github/scripts/local-builder-common.ps1`, unchanged.
  As built: the file also holds `Get-ScenarioNamesFromTaskBody`, `Get-ScenarioHeadings`, `Sanitize-LogText`, the artifact size limits, and a new `Resolve-ChangeSelection` (the old `parse-change` selection logic), so `start`, `build`, and `publish` all select tasks the same way.
  Files:
  - .github/scripts/local-builder-common.ps1
  - .github/scripts/local-builder.ps1
- [x] 1.2 Dot-source it from `local-builder.ps1`. The existing harness path checks still pass.

## 2. `start` job
- [x] 2.1 Add job `start` on `ubuntu-latest` with the owner-only `if:` guard (moved from `build`) and `timeout-minutes: 10`.
  As built: permissions are `contents: read` (for checkout) plus `issues: write`.
- [x] 2.2 Move "Record start time and mark issue running" and "Parse change id" into `start` (`shell: pwsh`). Expose `change_id`, `task_spec`, and `job_start` as job outputs. Keep the regexes.
  As built: `tasks.md` is checked in the `github.sha` checkout instead of through the contents API. `start` also runs `Resolve-ChangeSelection`, so a bad `tasks:` line or `Files:` list fails before the PC is used.
- [x] 2.3 On failure, `start` exposes a `reason` output.
  As built: `report` posts the comment for start failures too, so there is one place for failure comments (design.md §5).

## 3. `build` job (no write token)
- [x] 3.1 Set `build` to `needs: start`, `permissions: { contents: read }`, and the same runner labels and 60-minute timeout. Remove every `GH_TOKEN`/`github.token` reference from it. Read `CHANGE_ID`, `TASK_SPEC`, and `JOB_START` from `needs.start.outputs` via job `env:`.
- [x] 3.2 Checkout with `ref: ${{ github.sha }}` and `persist-credentials: false`.
- [x] 3.3 In `parse-change`, drop the `origin/master` re-fetch and create the branch from `$env:GITHUB_SHA`; set `LOCAL_BUILDER_BASE` to it.
- [x] 3.4 Remove `Get-GitIntegrity`, `Assert-GitIntegrity`, the snapshot write, and the `publish` step and its helpers from `local-builder.ps1`. The Git 2.32 version check is dropped too, because publish git now runs on `ubuntu-latest`.
- [x] 3.5 Add `-Step package`: after the guard passes, write `$RUNNER_TEMP/lb-result/manifest.json` and `files/<n>` per design.md §3.
  As built: each blob is the staged, line-ending-normalized git blob (`git add`, then `git cat-file blob :path`). The Windows checkout has CRLF in the working tree, and publishing raw bytes from Linux would commit CRLF.
- [x] 3.6 Write the failure report (`reason.txt`, `blocked.md` if present, `log-excerpt.txt`) to `$RUNNER_TEMP/lb-report/`.
  As built: this is an inline step with `if: failure() || cancelled()`, not a script step, so it still works when checkout failed.
- [x] 3.7 Upload `local-builder-result` (on success) and `local-builder-report` (on failure or cancel) with `actions/upload-artifact` v7.0.2 pinned to `cf430e0…`, `retention-days: 1`, and `if-no-files-found: error` for the result.
- [x] 3.8 Keep "Cleanup workspace" as the last step with `if: always()`, and add `lb-result` and `lb-report` to its patterns.

## 4. `publish` job
- [x] 4.1 Add job `publish` on `ubuntu-latest`, `needs: [start, build]`, `if: needs.build.result == 'success'`, `permissions: { contents: write, pull-requests: write, issues: write }`, `timeout-minutes: 15`, `shell: pwsh`. Print the PowerShell version first.
- [x] 4.2 Add `.github/scripts/local-builder-publish.ps1` with every check in design.md §4: size limits, schema, base sha equals `github.sha`, change id equals `start`'s, re-derived allowed list, path rules, sha256 and bytes, no symlinks or junctions, and a post-write `git status` that matches the manifest exactly. Port `Invoke-PublishGit`, `Get-PublishPushArgs`, `Get-RemoteBranchSha`, and `Publish-PullRequest` from `1ee78fb`. Build the PR title, body, and stats block from trusted values only.
  As built: the same script also runs the `start` and `report` steps (`-Step start|publish|report`). `Invoke-PublishGit` uses `/dev/null` instead of `NUL` on Linux.
  Files:
  - .github/scripts/local-builder-publish.ps1
- [x] 4.3 Harness cases, each of which must make `publish` push nothing: a path not in the allowed list; `.github/x`; `../x`; an absolute path; a non-normalized path; a duplicate path; a wrong `base_sha`; a wrong `change_id`; a same-size sha256 mismatch; an extra unlisted file; 11 files; a blob over 512 KB; over 1 MB in total; a manifest over 16 KB; invalid JSON; `attempts: 3`; free text in stats; unknown top-level and file-entry keys; a bad op; blob path traversal; and a junction at the target path. Each case is checked against an untouched checkout and must be rejected by its own check.
- [x] 4.4 Steps: checkout `github.sha` (`persist-credentials: false`), download `local-builder-result` with `actions/download-artifact` v8.0.2 pinned to `9000827…`, then run the publish script. No `npm`, `npx`, or `node` (checked by the harness).

## 5. `report` job
- [x] 5.1 Add job `report` on `ubuntu-latest`, `needs: [start, build, publish]`, `timeout-minutes: 10`.
  As built: the condition is `always() && needs.start.result != 'skipped' && needs.publish.result != 'success'`, so it also covers start failures. Permissions are `contents: read` (checkout) plus `issues: write`.
- [x] 5.2 Download `local-builder-report` with `continue-on-error: true`. Build the comment per design.md §5 (size caps, redaction, `@` neutralized, a fence longer than any backtick run, `::` neutralized). Reason precedence: start's `reason` output, then publish's `reason` output when `build` succeeded, then the artifact, then the fixed fallback.
- [x] 5.3 Add `local-builder-failed` and remove `local-builder-running`.
- [x] 5.4 Harness cases for the sanitizer: an `@mention`, a backtick fence in the text, a `::set-env` line, a token, text over the length limits, the fallback, and `BLOCKED.md`.

## 6. Harness and verify
- [x] 6.1 Update `.github/scripts/local-builder.tests.ps1`: remove the integrity checks; load the publish functions from `local-builder-publish.ps1`; add the workflow-shape checks from design.md §6 (plus: every checkout drops credentials and every action is pinned to a commit SHA); keep the timeout check across all jobs.
- [ ] 6.2 [Duane, with Team] Dry runs on the PC: (a) a bad change id, so `report` comments with start's reason; (b) Ollama quit, so `report` comments with the pre-flight reason; (c) a real small card, so the PR opens with the label, title, branch, and stats block; (d) a cancelled `build`, so `report` comments. These confirm:
  - artifacts work on the self-hosted runner;
  - `needs.*.result`, `always()`, and outputs from a failed step behave as expected;
  - `pwsh` exists on `ubuntu-latest`;
  - the publish script, which was tested only on Windows, also works on Linux.
- [x] 6.3 Run the harness plus `npm test`, `npx tsc --noEmit`, and `npm run check:worker`. All pass.
  As built: 155 harness checks passed on Windows PowerShell 5.1. `pwsh` and `actionlint` aren't installed on the dev machine, so neither was run.
- [ ] 6.4 Confirm PR #13's acceptance criteria, as changed in design.md §9 (QA).
- [x] 6.5 Remove `cache: npm` from the `deploy-poc.yml` deploy job (design.md §10, item 3). Done separately in PR #22, not as part of this change.
- [ ] 6.6 Push to the PR #13 branch (done: `960c5f4`). Code Reviewer re-reviews, QA retests, and Duane merges.
