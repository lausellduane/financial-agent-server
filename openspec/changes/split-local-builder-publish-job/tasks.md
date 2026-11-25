# Tasks: split-local-builder-publish-job

> - Work on the PR #13 branch (`chore/local-builder-workflow`) only, started by an `@claude` comment on PR #13.
>   Never push to `master`. Nothing starts until Duane merges this folder.
> - This change allows edits to `.github/workflows/local-builder.yml` and `.github/scripts/local-builder*.ps1`.
> - **[Duane]** = Duane does it on the PC or in GitHub.

## 1. Shared path rules
- [ ] 1.1 Move `Get-NormalizedPath`, `Test-SafeRelPath`, `Test-ForbiddenPath`, `Test-AiderArtifact`, `Get-TaskBlocks`, and `Get-FilesFromTaskBody` into `.github/scripts/local-builder-common.ps1`, unchanged.
  Files:
  - .github/scripts/local-builder-common.ps1
  - .github/scripts/local-builder.ps1
- [ ] 1.2 Dot-source it from `local-builder.ps1`. The existing harness path checks still pass.

## 2. `start` job
- [ ] 2.1 Add job `start` on `ubuntu-latest` with `permissions: { issues: write }`, the owner-only `if:` guard (moved from `build`), and `timeout-minutes: 10`.
- [ ] 2.2 Move "Record start time and mark issue running" and "Parse change id" into `start` (`shell: pwsh`). Expose `change_id`, `task_spec`, and `job_start` as job outputs. Keep the regexes and the `tasks.md exists on master` check unchanged.
- [ ] 2.3 On failure, `start` posts its own failure comment and `local-builder-failed` (it runs no repo code, so it can use the token directly).

## 3. `build` job (no write token)
- [ ] 3.1 Set `build` to `needs: start`, `permissions: { contents: read }`, and the same runner labels and 60-minute timeout. Remove every `GH_TOKEN`/`github.token` reference from it. Read `CHANGE_ID`, `TASK_SPEC`, and `JOB_START` from `needs.start.outputs` via `env:`.
- [ ] 3.2 Checkout with `ref: ${{ github.sha }}` and `persist-credentials: false`.
- [ ] 3.3 In `parse-change`, drop the `origin/master` re-fetch and create the branch from `$env:GITHUB_SHA`; set `LOCAL_BUILDER_BASE` to it.
- [ ] 3.4 Remove `Get-GitIntegrity`, `Assert-GitIntegrity`, the snapshot write, and the `publish` step and its helpers from `local-builder.ps1`.
- [ ] 3.5 Add `-Step package`: after the guard passes, write `$RUNNER_TEMP/lb-result/manifest.json` and `files/<n>` per design.md §3.
- [ ] 3.6 Add `-Step report-files` (`if: always()`): write `$RUNNER_TEMP/lb-report/` with `reason.txt`, `blocked.md` (if present), and `log-excerpt.txt`.
- [ ] 3.7 Upload `local-builder-result` (`if: success()`) and `local-builder-report` (`if: always()`) with `actions/upload-artifact` pinned to a full commit SHA, `retention-days: 1`, and `if-no-files-found: error` for the result.
- [ ] 3.8 Keep "Cleanup workspace" as the last step with `if: always()`, and add `lb-result` and `lb-report` to its patterns.

## 4. `publish` job
- [ ] 4.1 Add job `publish` on `ubuntu-latest`, `needs: [start, build]`, `if: needs.build.result == 'success'`, `permissions: { contents: write, pull-requests: write, issues: write }`, `timeout-minutes: 15`, `shell: pwsh`. Print `$PSVersionTable` first.
- [ ] 4.2 Add `.github/scripts/local-builder-publish.ps1` with every check in design.md §4: size limits, schema, base sha equals `github.sha`, change id equals `start`'s, re-derived allowed list, path rules, sha256 and bytes, no symlinks, and a post-write diff that matches the manifest exactly. Port `Invoke-PublishGit`, `Get-PublishPushArgs`, `Get-RemoteBranchSha`, and `Publish-PullRequest` from `1ee78fb`. Build the PR title, body, and stats block from trusted values only.
  Files:
  - .github/scripts/local-builder-publish.ps1
- [ ] 4.3 Harness cases, each of which must make `publish` push nothing: a path not in the allowed list; `.github/x`; `../x`; an absolute path; a duplicate path; a wrong `base_sha`; a wrong `change_id`; a sha256 mismatch; an extra unlisted file in the artifact; an oversize manifest; `attempts: 3`; an unknown key; and a symlink at the target path.
- [ ] 4.4 Steps: checkout `github.sha` (`persist-credentials: false`), download `local-builder-result` with `actions/download-artifact` pinned to a full commit SHA, then run the publish script. No `npm`, `npx`, or `node`.

## 5. `report` job
- [ ] 5.1 Add job `report` on `ubuntu-latest`, `needs: [start, build, publish]`, `if: always() && needs.start.result == 'success' && needs.publish.result != 'success'`, `permissions: { issues: write }`, `timeout-minutes: 10`.
- [ ] 5.2 Download `local-builder-report` with `continue-on-error: true`. Build the comment per design.md §5 (size caps, redaction, `@` neutralized, a fence longer than any backtick run, `::` neutralized). Use the fixed fallback text when the artifact is missing. When `build` succeeded and `publish` failed, use `needs.publish.outputs.reason` (a fixed string set by `publish`).
- [ ] 5.3 Add `local-builder-failed` and remove `local-builder-running`.
- [ ] 5.4 Harness cases for the sanitizer: an `@mention`, a backtick fence in the text, a `::set-env` line, and text over the length limits.

## 6. Harness and verify
- [ ] 6.1 Update `.github/scripts/local-builder.tests.ps1`: remove the integrity checks; load the publish functions from `local-builder-publish.ps1`; add the workflow-shape checks from design.md §6; keep the timeout check across all jobs.
- [ ] 6.2 [Duane, with Team] Dry runs on the PC: (a) a bad change id, so `start` comments; (b) Ollama quit, so `report` comments with the pre-flight reason; (c) a real small card, so the PR opens with the label, title, branch, and stats block; (d) a cancelled `build`, so `report` comments with the fallback text. These confirm artifacts on the self-hosted runner and the `needs.*.result` and `always()` behavior.
- [ ] 6.3 Run `pwsh -File .github/scripts/local-builder.tests.ps1` plus `npm test`, `npx tsc --noEmit`, and `npm run check:worker`. All pass.
- [ ] 6.4 Confirm PR #13's acceptance criteria, as changed in design.md §9.
- [ ] 6.5 Push to the PR #13 branch. Code Reviewer re-reviews, QA retests, and Duane merges.
