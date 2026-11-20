# local-builder

## ADDED Requirements

### Requirement: Owner-only label trigger
The local builder workflow SHALL run only on the `issues` `labeled` event. It MUST start work only when the label is `local-builder`, the labeling user (`github.event.sender.login`) is `lausellduane`, and the issue author is `lausellduane`. It MUST NOT be triggered by `pull_request`, `pull_request_target`, `push`, `issue_comment`, `workflow_run`, or any fork event.

#### Scenario: Duane labels his own issue
- **WHEN** `lausellduane` adds the `local-builder` label to an issue he opened
- **THEN** a job is queued on a runner with labels `self-hosted` and `local-builder`

#### Scenario: Someone else labels the issue
- **WHEN** any user other than `lausellduane` adds the `local-builder` label
- **THEN** the job is skipped and no code runs on the self-hosted runner

#### Scenario: Different label
- **WHEN** `lausellduane` adds any label other than `local-builder`
- **THEN** the job is skipped

#### Scenario: Fork pull request opened
- **WHEN** an outside contributor opens a pull request from a fork
- **THEN** no job is scheduled on the self-hosted runner

### Requirement: Approved OpenSpec change as the only instructions
The workflow SHALL read a single change ID from the issue body (line `openspec-change: <id>`), and that ID MUST match `^[a-z0-9-]+$`. It MUST require `openspec/changes/<id>/tasks.md` to exist on the default branch. Issue title and body text MUST NOT be put into shell scripts through `${{ }}` expressions, and MUST NOT be passed to the agent as instructions.

#### Scenario: Valid approved change
- **WHEN** the issue body contains `openspec-change: fix-other-money-in-prompt` and that change exists on `master`
- **THEN** the agent is given that change's proposal, tasks, and specs as read-only context

#### Scenario: Missing or malformed change ID
- **WHEN** the change ID is missing, fails the pattern, or does not exist on `master`
- **THEN** the workflow comments the reason on the issue, adds `local-builder-failed`, and opens no PR

### Requirement: Least-privilege, secret-free job
The job SHALL authenticate only with the job's `GITHUB_TOKEN`. The workflow-level permission MUST be `permissions: {}`, and the job MUST be granted only `contents: write`, `pull-requests: write`, and `issues: write`. The workflow MUST NOT reference any repository, environment, or organization secret. The checkout MUST use `persist-credentials: false`.

#### Scenario: Secrets are absent
- **WHEN** Code Reviewer inspects the workflow file
- **THEN** it contains no `secrets.` references, and no step receives Cloudflare credentials

#### Scenario: Agent cannot use the token
- **WHEN** the coding agent and tests are running
- **THEN** no GitHub token is present in `.git/config` or in the agent step's environment

### Requirement: PR-only output on a dedicated branch
The workflow SHALL push only to a branch named `local-builder/issue-<N>` and SHALL open a pull request to `master`. It MUST NOT push to `master`, and `master` MUST be protected by a rule that requires a pull request and blocks force pushes. The workflow MUST fail without pushing if the diff touches `.github/**`, `wrangler.*`, migrations, env or key files, or files not listed in the change's tasks.

#### Scenario: Successful run
- **WHEN** the agent produces a diff limited to the listed files and `npm test` passes
- **THEN** a PR from `local-builder/issue-<N>` to `master` is opened that references the issue and lists the spec scenarios

#### Scenario: Forbidden path changed
- **WHEN** the diff includes a path under `.github/workflows/`
- **THEN** nothing is pushed, the issue gets a failure comment, and the label `local-builder-failed` is added

#### Scenario: Direct push attempt
- **WHEN** any push to `master` is attempted with the job token
- **THEN** GitHub rejects it

### Requirement: Bounded runtime and failure reporting
The job SHALL have `timeout-minutes: 60`. Each agent attempt MUST be limited to 25 minutes, with at most 2 attempts. On timeout, test failure, or no diff, the workflow MUST comment on the issue with the reason and a short log excerpt, remove `local-builder-running`, add `local-builder-failed`, and open no PR.

#### Scenario: Agent produces no diff
- **WHEN** both attempts finish with no file changes
- **THEN** the issue receives a comment "no changes produced" with a log excerpt, gets `local-builder-failed`, and no PR is opened

#### Scenario: Agent hangs
- **WHEN** an agent attempt exceeds 25 minutes
- **THEN** the step is cancelled, the failure comment is posted, and no PR is opened


### Requirement: Hardened runner host
The runner SHALL run as a Windows service under a dedicated non-administrator local user, registered to a single repository. Ollama MUST listen on `127.0.0.1` only. The workspace MUST be cleaned after every job.

#### Scenario: Ollama not exposed
- **WHEN** another device on the LAN connects to the PC on TCP 11434
- **THEN** the connection is refused or blocked

#### Scenario: Workspace cleaned
- **WHEN** a job finishes, whether it succeeded or failed
- **THEN** the job's workspace and temp folders are emptied

#### Scenario: Kill switch
- **WHEN** Duane stops the `actions.runner.*` service
- **THEN** no further local-builder jobs run, and labeled issues stay queued until the service starts again or GitHub expires them after 24 hours

### Requirement: Human review gates before merge
Every local-builder PR SHALL be reviewed by Code Reviewer against the change's spec scenarios and tested by QA Engineer before merge. Only Duane MUST merge.

#### Scenario: QA has not tested
- **WHEN** a local-builder PR has no QA pass recorded
- **THEN** it is not merged

### Requirement: Ollama pre-flight check and warm-up
Before checkout and before the agent runs, the workflow SHALL call `http://127.0.0.1:11434/api/tags` and MUST confirm that the configured model is listed. If the check fails, the workflow MUST comment on the issue saying Ollama is unreachable (for example, Duane needs to sign in after a Windows Update reboot), MUST add `local-builder-failed`, and MUST NOT run the agent or open a PR. After a successful check, the workflow SHALL send a warm-up prompt with the same `num_ctx` (4096) and a `keep_alive` before the first agent attempt.

#### Scenario: Ollama down after a reboot
- **WHEN** the PC rebooted for a Windows update, Duane hasn't signed in yet, and a labeled issue starts a job
- **THEN** the issue receives a comment that Ollama isn't reachable at 127.0.0.1:11434, the label `local-builder-failed` is added, and no agent runs and no PR opens

#### Scenario: Model not pulled
- **WHEN** Ollama responds but `qwen2.5-coder:7b` isn't in the model list
- **THEN** the issue receives a comment naming the missing model, and no agent runs

#### Scenario: Warm-up before agent
- **WHEN** the pre-flight check passes
- **THEN** a warm-up request with `num_ctx` 4096 completes before Aider starts, and Aider's requests use the same `num_ctx`, so the model isn't reloaded

### Requirement: Context fits 4K tokens
The agent SHALL run with `num_ctx` 4096 and Aider's repo map turned off (`--map-tokens 0`). Its read-only context MUST be limited to `conventions/CONVENTIONS.md` and the change's `tasks.md`. The job prompt MUST be rendered from `prompts/job-prompt.md`, using only the change path, task numbers, file list, scenario headings, attempt number, and the repo's own test-failure output. It MUST NOT include any issue title, body, or comment text. The workflow MUST fail without running the agent if the estimated prompt plus files exceeds the budget (about 2,500 tokens).

#### Scenario: Oversized task
- **WHEN** the rendered prompt, read files, and edit files are estimated above the budget
- **THEN** the issue receives a "task too large for 4K context" comment, gets `local-builder-failed`, and no agent runs

#### Scenario: Issue text excluded
- **WHEN** an issue body contains extra instructions besides the `openspec-change:` and `tasks:` lines
- **THEN** the rendered job prompt contains none of that text

### Requirement: Agent conventions and BLOCKED note
The agent SHALL be given `conventions/CONVENTIONS.md` as read-only context. If the agent writes `BLOCKED.md`, the workflow MUST post its contents on the issue, MUST add `local-builder-failed`, and MUST NOT open a PR.

#### Scenario: Unclear task
- **WHEN** the agent can't complete a task within the listed files and writes `BLOCKED.md`
- **THEN** the issue receives a comment with the BLOCKED note, and no branch is pushed and no PR is opened

### Requirement: Local builder PR tracking
Every PR opened by the local builder SHALL use branch `local-builder/issue-<N>`, SHALL have the `local-builder` label, and SHALL have a title that starts with `[local-builder]`. The PR body MUST end with a stats block, marked `<!-- local-builder-stats -->`, that lists the model and num_ctx, attempts used out of 2, run time from job start to PR opened, and whether tests passed on the first try.

#### Scenario: PR markers present
- **WHEN** the local builder opens a PR for issue 42
- **THEN** the PR's head branch is `local-builder/issue-42`, it has the `local-builder` label, and its title starts with `[local-builder]`

#### Scenario: Stats block present
- **WHEN** a local-builder PR is opened after the second attempt passed tests
- **THEN** the body ends with a stats block that shows the model `qwen2.5-coder:7b (num_ctx 4096)`, attempts `2 of 2`, the run time, and tests passed on first try `no`

#### Scenario: PR label does not retrigger the workflow
- **WHEN** the workflow adds the `local-builder` label to its own PR
- **THEN** no new local-builder job starts

### Requirement: Review-performance comparison
The team SHALL be able to compare local-builder PRs with Builder's PRs by searching `label:local-builder` versus `-label:local-builder`. Each local-builder PR MUST have Code Reviewer findings by severity and a QA first-pass result recorded, the same as Builder's PRs.

#### Scenario: Listing local-builder PRs
- **WHEN** Project Manager runs `gh pr list --state all --search "label:local-builder"` on financial-agent-server
- **THEN** every PR the local builder opened is returned, and no Builder PR is

#### Scenario: Comparing review results
- **WHEN** Project Manager builds the weekly comparison
- **THEN** each local-builder PR has its Code Reviewer HIGH/MEDIUM/LOW counts, QA first-pass result, merge status, and stats-block values recorded beside similar-sized Builder PRs
