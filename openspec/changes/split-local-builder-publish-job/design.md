# Design: Split the local builder's publish into its own job

Checked against GitHub docs on Nov 24, 2026 (sources at the end). Items not confirmed in the docs are marked
**[unverified]**. Code references are to PR #13 at `1ee78fb`.

## 1. Threat model

**What we protect:** the write-scoped `GITHUB_TOKEN` (contents, pull-requests, issues). With it, an attacker could
push any branch, open PRs, or post comments. It still could not push to `master`, because of `protect-master`, and
it could not edit workflows, because the token has no `workflows` scope.

**Who the attacker is:** the code the model writes. Whatever the model writes runs as `ghrunner` during
`npm test` (Aider's `--auto-test`, the evaluate step, and the guard step) and during `npx tsc`. A prompt-injected
spec or a bad model output is enough. No outsider access is needed.

**Why one job can't be fixed:** after model code has run as `ghrunner` on the self-hosted box, everything that
`ghrunner` owns is suspect for the rest of that job:

- **Command files.** It can append to the job's `GITHUB_ENV` and `GITHUB_PATH` files under
  `RUNNER_TEMP\_runner_file_commands`. Every later step in the job inherits those values: a fake
  `powershell.exe` or `git.exe` first on `PATH`, `PSModulePath`, `GIT_*`, `GIT_SSH_COMMAND`, and so on.
  GitHub blocks only `NODE_OPTIONS` and the `GITHUB_*` and `RUNNER_*` names. It does not block `PATH` (through
  `GITHUB_PATH`) or `PSModulePath`.
- **Lingering processes.** A background process started by the tests is still running when publish starts. It
  can read the new step's environment or memory, which is the same user.
- **The runner itself.** The runner service also runs as `ghrunner`, so model code can tamper with the runner's
  own files and processes. That means `build`'s step outputs and even its reported result can't be fully
  trusted (see §5).

Commit `1ee78fb` closed the git-level holes (hooks, fsmonitor, global config, `.git` integrity, lease push).
It can't close the ones above, because they don't go through git.

**The fix:** the write token is never minted for a job on the self-hosted runner. GitHub creates a separate
`GITHUB_TOKEN` per job with that job's `permissions`, and `GITHUB_ENV` and `GITHUB_PATH` reach only later
steps of the same job. A job on a fresh GitHub-hosted VM shares no files, processes, or environment with `build`.
The only things that cross over are the job result and the artifacts, and `publish` treats both as untrusted
input that it checks itself.

## 2. Job layout

```yaml
name: local-builder
on:
  issues:
    types: [labeled]
permissions: {}
concurrency: { group: local-builder, cancel-in-progress: false }

jobs:
  start:            # ubuntu-latest, issues: write
    if: <owner-only guard, unchanged>
    outputs: { change_id, task_spec, job_start }
    # parse event payload (regexes unchanged), swap local-builder -> local-builder-running, record start time

  build:            # [self-hosted, windows, local-builder], contents: read
    needs: start
    timeout-minutes: 60
    # pre-flight, checkout github.sha (persist-credentials: false), tools, parse-change,
    # warm-up, npm ci, render, aider 1, evaluate, aider 2, guard   (as today, minus integrity snapshot)
    # package           -> writes $RUNNER_TEMP/lb-result/ (only if guard passed)
    # upload result     -> actions/upload-artifact, name local-builder-result, retention-days 1 (if: success())
    # write report      -> $RUNNER_TEMP/lb-report/ (if: always())
    # upload report     -> name local-builder-report, retention-days 1 (if: always())
    # cleanup           -> unchanged (if: always())

  publish:          # ubuntu-latest, contents/pull-requests/issues: write
    needs: [start, build]
    if: needs.build.result == 'success'
    # checkout github.sha (persist-credentials: false), download local-builder-result,
    # validate + apply + commit + lease push + open/reuse PR + label PR + drop local-builder-running

  report:           # ubuntu-latest, issues: write
    needs: [start, build, publish]
    if: always() && needs.start.result == 'success' && needs.publish.result != 'success'
    # reason: needs.publish.outputs.reason if build succeeded, else local-builder-report artifact
    # (continue-on-error; fallback text if missing); sanitize, comment, labels
```

Notes:

- **`start` replaces two steps:** "Record start time and mark issue running" and "Parse change id". Both
  already ran before model code, but they used the write token inside the self-hosted job, which this change
  removes. `start` also does the `tasks.md exists on master` API check. `build` receives `change_id`, `task_spec`,
  and `job_start` as `needs.start.outputs`, which are trusted because `start` runs no repo code.
- **`report`'s condition** covers every failure: `build` failed, timed out, or was cancelled (so `publish` is
  skipped), or `publish` failed. If `start` itself failed, its own failure step comments, which needs no artifact.
  `needs.<job>.result` and `always()` in a dependent job are standard practice but not spelled out on the pages
  checked **[unverified]**. The apply step confirms them with a dry run (task 6.2).
- **`build` keeps `contents: read`, not `permissions: {}`** (recommended default, §10). `actions/checkout` uses
  the job token. On a public repo, a leaked read token reveals nothing that isn't already public. With `{}`,
  checkout might fail **[unverified]**, and a broken pilot costs more than the tiny gain. It can be tightened later.
- **Cost:** `start`, `publish`, and `report` each take about 1 to 2 minutes on `ubuntu-latest`, which is free for
  public repos.
- **`pwsh` on `ubuntu-latest`:** the Ubuntu 24.04 image ships PowerShell 7. `ubuntu-latest` is moving to 26.04
  in November 2026 **[unverified that 26.04 ships pwsh]**. Task 3.1 pins the shell as `shell: pwsh`, and the first
  step prints `$PSVersionTable`, so a missing `pwsh` fails loudly.

## 3. The artifact format

**Decision: full file contents plus a manifest, not a git patch.**

A patch would make `publish` run `git apply` on attacker-shaped input. Patches can carry renames, mode changes,
symlinks, binary hunks, and paths that must be parsed before they can be checked. Full file contents are simpler:
every path is checked first, and only then is a plain file written.

`$RUNNER_TEMP/lb-result/`:

```
manifest.json
files/0
files/1
...
```

```json
{
  "version": 1,
  "base_sha": "<40 hex, must equal github.sha>",
  "change_id": "<must equal needs.start.outputs.change_id>",
  "files": [
    { "path": "src/a.ts", "op": "write",  "blob": "files/0", "sha256": "<64 hex>", "bytes": 1234 },
    { "path": "src/b.ts", "op": "delete" }
  ],
  "stats": { "attempts": 1, "tests_first_try": "yes", "edit_format": "whole" }
}
```

- Blobs are named by index, not by path. That avoids `upload-artifact`'s default exclusion of hidden
  (dot-) files, and no attacker-chosen path is ever used as a filename on the `publish` side.
- `package` builds the list from `Get-ChangedFiles` against the base, after the guard step passed, with the
  same filters as today.
- `retention-days: 1`. **Artifacts are visible to anyone with read access, and this is a public repo.**
  The contents are the same diff that will be public in the PR, and the same log excerpt that would be posted
  on the issue. Nothing secret belongs in either, and `package` writes nothing else.

## 4. What `publish` checks (artifact is untrusted)

`publish` re-derives everything it can from trusted sources: the event payload, `start`'s outputs, and the
checkout of `github.sha`. From the artifact it takes only file bytes and three enumerated stats.

1. **Size before parsing.** The manifest lists at most 10 files. Each blob is at most 512 KB, the downloaded
   directory is at most 1 MB in total, and `manifest.json` is at most 16 KB. A normal card is about 20 KB; the
   per-file limit leaves room for `package-lock.json` (147 KB today) if a task lists it. Anything else in the directory that the manifest doesn't list is rejected.
2. **Schema.** `version == 1`. `base_sha` matches `^[0-9a-f]{40}$` **and equals `github.sha`**. `change_id`
   equals `needs.start.outputs.change_id`. `op` is `write` or `delete`. `blob` matches `^files/[0-9]+$`. The
   stats come from fixed sets: `attempts` is 1 or 2, `tests_first_try` is `yes` or `no`, and `edit_format` is
   `whole` or `diff`. Any unknown key is rejected.
3. **Paths.** `publish` re-runs `parse-change` logic (`Get-TaskBlocks`, `Get-FilesFromTaskBody`) on
   `openspec/changes/<id>/tasks.md` at `github.sha` with `start`'s `task_spec`, to get its own allowed list. Each
   manifest path must pass `Test-SafeRelPath`, must not be `Test-ForbiddenPath`, must be in that allowed list,
   and must not be listed twice. Path checks use the shared functions (§6), so `build` and `publish` can't drift.
4. **Content.** Each blob's SHA-256 and byte count match the manifest. Before writing, the target path in the
   checkout must not be a symlink and must not have a symlink as a parent. Files are written as plain bytes.
5. **Result check.** After writing, `git status --porcelain` and `git diff --name-only github.sha` must list
   exactly the manifest's paths, with no mode changes. The diff must not be empty.
6. **No execution.** `publish` never runs `npm`, `npx`, `node`, tests, or anything from the artifact or the
   changed files. Tests already ran on the PC, and they run again in CI after Duane approves the workflow run.
   `npm ci` would run install scripts, and a task may list `package.json`.
7. **PR text.** Title, body, branch name, and commit message are built only from trusted values (issue number,
   re-derived change ID and task numbers, scenario headings from the checkout) plus the three enumerated stats.
   Run time is `now - needs.start.outputs.job_start`.

On any failure, `publish` writes a fixed reason ("artifact rejected: <check name>") and fails. `report` then
comments. The artifact's own text is never echoed into that reason.

**Why `github.sha` as the base:** today `parse-change` fetches `origin/master` again mid-job and records it in
`GITHUB_ENV`. If `publish` trusted a base sha from the artifact, it would need to prove that sha is on `master`.
Pinning both jobs to `github.sha` (the default-branch head when the label was added) gives one trusted base with
nothing to prove. A relabel retry still starts from the latest `master`, because relabeling creates a new
event. The only difference: if `master` moves while the job is queued, the PR is based on the older commit
and GitHub shows any conflict. This is the recommended default (§10).

## 5. Failure reporting (`report` job)

- **Who posts:** `report`, on `ubuntu-latest` with `issues: write`. `build` can't post, because it has no
  token. `publish` doesn't post either. It just fails, so there is one place for comments.
- **Input:** the `local-builder-report` artifact (`reason.txt`, `blocked.md`, `log-excerpt.txt`), downloaded
  with `continue-on-error: true`. If it is missing, for example because `build` was cancelled or the runner
  died, the comment says "The local-builder job failed or was cancelled before it could report a reason"
  and links the run.
- **Publish failures:** `publish` exposes its fixed reason string as a job output (`needs.publish.outputs.reason`).
  `publish` runs no untrusted code, so its outputs can be trusted. When `build` succeeded and `publish` failed,
  `report` uses that reason instead of the `build` artifact.
- **Sanitizing (untrusted text):**
  - reason at most 2,000 characters, `BLOCKED.md` at most 2,000, excerpt at most 40 lines and 6,000 characters;
  - the existing token redaction is kept;
  - `@` is replaced with `@​` so the comment can't ping anyone;
  - the excerpt goes in a code fence longer than any backtick run inside it;
  - lines starting with `::` are neutralized, as today.
- **Labels:** add `local-builder-failed`, remove `local-builder-running`, as today.
- `build`'s reported result can't be fully trusted (§1). A compromised `build` could report success. That is
  fine, because `publish` re-validates everything. The worst outcome is a PR containing allowed files with
  bad content, which Code Reviewer, QA, and CI then catch. That is the same risk as a model that simply
  writes bad code.

## 6. Scripts and harness

- **`.github/scripts/local-builder.ps1` (build side):**
  - Remove `publish`, `Get-GitIntegrity`, `Assert-GitIntegrity`, `Invoke-PublishGit`, `Get-PublishPushArgs`,
    `Get-RemoteBranchSha`, `Publish-PullRequest`, and `Invoke-GitHub`.
  - Remove the snapshot write in `parse-change` and the `Assert-GitIntegrity` call in `guard`.
  - Remove the `origin/master` re-fetch in `parse-change`. The branch is created from `github.sha`
    (`LOCAL_BUILDER_BASE = $env:GITHUB_SHA`).
  - Add `-Step package` (§3) and `-Step report-files` (§5).
- **Shared path rules:** move `Get-NormalizedPath`, `Test-SafeRelPath`, `Test-ForbiddenPath`, `Test-AiderArtifact`,
  `Get-TaskBlocks`, and `Get-FilesFromTaskBody` into `.github/scripts/local-builder-common.ps1`. Both scripts
  dot-source it. `publish` loads its copy from the trusted `github.sha` checkout, never from the artifact.
- **`.github/scripts/local-builder-publish.ps1` (new, runs on `ubuntu-latest` under `pwsh`):** the validation
  in §4, plus the code ported from `1ee78fb`: `Invoke-PublishGit` (kept as cheap defense in depth even on a
  fresh VM, and it satisfies the approved "token not exposed to git hooks" requirement), `Get-PublishPushArgs`,
  `Get-RemoteBranchSha`, `Publish-PullRequest`, the PR body and stats block, and labeling the PR.
- **Integrity snapshot:** removed. It existed only to protect the token in the same job, and `publish` now
  works on a fresh checkout. `build` doesn't need it either: its only output is validated again by `publish`.
- **`.github/scripts/local-builder.tests.ps1`:**
  - Remove the integrity checks (`integrity: ...` and the fsmonitor/global-config attack checks that only
    existed to prove the snapshot worked).
  - Keep the publish-git, lease-push, and PR-reuse checks, now loaded from `local-builder-publish.ps1`.
  - Change the timeout check to parse steps in every job, not just one (the `^      - name:` parser already sees
    them all, but the expected step count changes).
  - Add workflow checks: `build` has exactly `contents: read`; no `github.token`, `secrets.`, or `GH_TOKEN` in
    `build`; write scopes only on `start`, `publish`, and `report`; those three use `ubuntu-latest`;
    `publish` and `report` have no `needs.build.outputs`.
  - Add artifact-tampering cases (task 4.3).

## 7. Residual risks (not fixed here)

- **The PC after a bad run.** Model code can persist as `ghrunner`, for example by tampering with the runner
  install, and affect later `build` jobs. Today's mitigations stay in place: a non-admin user, no secrets, cleanup,
  and the weekly wipe. This change ensures that even a fully compromised PC never sees a write token, and that
  whatever it produces is re-checked by `publish` and by human review.
- **Actions cache.** `issues` runs are on the default branch, and caches made on the default branch can be read
  by every branch. If a compromised `build` can write to the Actions cache, it could poison `deploy-poc.yml`'s
  `setup-node` npm cache. `npm ci` checks each package against `package-lock.json` integrity hashes, which limits
  this. Whether a `run:` step, or a lingering process, can get the cache credential is **[unverified]**; the
  docs say the cache mode env is set only for JavaScript and container actions. Cache entries also can't be
  overwritten, so an attacker would have to create the entry before the real one exists. **Follow-up, outside
  this change (§10):** remove `cache: npm` from the deploy job only (the one with Cloudflare secrets), and keep it
  on the test job. That costs about 20 to 30 seconds per deploy and removes the path where it matters.
- **Artifact visibility.** Any signed-in GitHub user can download it for one day (§3). Accepted (§10): it holds
  only what becomes public anyway in the PR or the failure comment, and the PC holds no secrets.

## 8. Steps that change

| Today (one job) | After |
|---|---|
| Record start time and mark issue running (token) | `start` job |
| Pre-flight Ollama | `build`, unchanged |
| Parse change id | `start` job (outputs to `build`) |
| Checkout `ref: master` | `build`, `ref: ${{ github.sha }}` |
| Check tools, warm-up, npm ci, render, Aider 1, evaluate, Aider 2 | `build`, unchanged |
| Parse change and create branch | `build`, without the re-fetch and snapshot |
| Verify diff, tests, and typecheck | `build`, without `Assert-GitIntegrity` |
| Commit, push, and open PR (token) | `publish` job |
| Comment on failure (token) | `report` job |
| Cleanup workspace | `build`, unchanged, always |
| — | `build`: package, upload result, write report, upload report |

## 9. PR #13 acceptance criteria that change

From `add-local-builder-runner` (spec and design §3, §6, §8) and `fix-local-builder-qa-findings`:

- **"Least-privilege, secret-free job."** Before: the job gets the three write scopes. After: `build` gets
  `contents: read`, and only `start`, `publish`, and `report` (GitHub-hosted) get write scopes, each only what it
  needs. Modified in this change's spec.
- **"Agent cannot use the token."** It still holds, and is stronger: no write token exists in any job that runs
  agent code.
- **design.md §3 "Agent token reuse" row.** "The token is given only to the final push and `gh pr create` steps"
  becomes "the token is given only to jobs on GitHub-hosted runners that run no agent code".
- **"Job token is not exposed to git hooks"** (fix change). Still met. The `publish` job commits with
  `core.hooksPath=NUL` and `--no-verify`, and passes the token only to push and API calls.
- **"Every workflow step is time-bounded"** (fix change). It now covers steps in all four jobs. Job timeouts:
  `start` 10, `build` 60, `publish` 15, `report` 10.
- **"Relabel retry with an existing branch"** (fix change). The branch is recreated from `github.sha` rather than
  a mid-job `origin/master` fetch. That is still the latest `master` as of the relabel. The lease push and PR reuse
  are unchanged.
- **"Guard diffs against the branch base."** The base is now `github.sha` in both `build` and `publish`.
- **Pilot criterion 2** ("PR opens within 60 minutes") now spans jobs. Run time in the stats block is measured
  from `start` to PR opened.
- **Pilot criterion 6** (failure path) is now done by `report`. The comment and labels are unchanged.
- **Pilot criterion 7** (no secrets on the PC) is strengthened: no write-scoped token is ever sent to the PC.

## 10. Recommended defaults (Duane confirms or overrules)

These are the defaults this change is written to. Merging this folder accepts them. To overrule one, comment
on the proposal PR before merging.

| # | Question | Default | Why |
|---|---|---|---|
| 1 | Which `master` commit the PR builds on | `github.sha` (head of `master` when the label was added), used by both `build` and `publish` | One trusted value, read straight from GitHub; `publish` has nothing to prove. Jobs run one at a time, so the gap is small, and a relabel gets a fresh `github.sha`. The alternative (fetch fresh `master` in `build`) makes `publish` prove an untrusted sha is on `master`. |
| 2 | `build` permissions | `contents: read` | Harmless on a public repo. `{}` might break checkout for a tiny gain. Can be tightened later. |
| 3 | npm cache in `deploy-poc.yml` | Accept for now; **separate follow-up** removes `cache: npm` from the deploy job only | Low risk: `run:` steps don't get the cache credential, entries can't be overwritten, and `npm ci` checks integrity hashes. Dropping it in the one job with secrets is cheap insurance. |
| 4 | Artifact visibility | Accept, with `retention-days: 1` | Holds nothing that isn't public anyway in the PR or the failure comment. The PC holds no secrets. |
| 5 | Artifact size limits | At most 10 files, 512 KB per file, 1 MB total, 16 KB manifest | Normal cards are about 20 KB. Leaves room for `package-lock.json` (147 KB) and rejects anything absurd. The allowed-file check is the main limit; these are a backstop. |

## Sources checked (Nov 24, 2026)

- GitHub Docs, *Workflow commands for GitHub Actions*: `GITHUB_ENV` and `GITHUB_PATH` apply to later steps in the
  job. `NODE_OPTIONS` can't be set through `GITHUB_ENV`. `GITHUB_*` and `RUNNER_*` can't be overwritten.
- GitHub Docs, *Events that trigger workflows* → `issues`: `GITHUB_SHA` is the last commit on the default branch.
- GitHub Docs, *Automatic token authentication*: `permissions` per job.
- GitHub Docs, *Passing information between jobs*: `outputs` and `needs.<job>.outputs`. *Expressions*: `always()`.
- `actions/upload-artifact` README (current major v7): `include-hidden-files` defaults to false, names unique per
  run, `retention-days` 1 to 90. `actions/download-artifact` (current major v8). Self-hosted support isn't stated
  in the README **[unverified]**, but uploads use the runner's own service, so the pilot confirms it (task 6.2).
- GitHub Docs, *Downloading workflow artifacts*: read access is required. On a public repo that's anyone signed in.
- GitHub Docs, *Caching dependencies*: default-branch caches can be restored from other branches.
- `actions/runner-images` Ubuntu 24.04 README: PowerShell 7 is installed.
