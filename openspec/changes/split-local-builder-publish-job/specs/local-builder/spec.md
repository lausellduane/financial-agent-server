# local-builder

## MODIFIED Requirements

### Requirement: Least-privilege, secret-free job
The workflow SHALL authenticate only with per-job `GITHUB_TOKEN`s. The workflow-level permission MUST be `permissions: {}`. The self-hosted `build` job, which runs the agent and model-written code, MUST be granted only `contents: read`. Write scopes MUST be granted only to jobs that run on GitHub-hosted runners and run no agent or model-written code: `start` (`issues: write`), `publish` (`contents: write`, `pull-requests: write`, `issues: write`), and `report` (`issues: write`). The workflow MUST NOT reference any repository, environment, or organization secret. Every checkout MUST use `persist-credentials: false`.

#### Scenario: Secrets are absent
- **WHEN** Code Reviewer inspects the workflow file
- **THEN** it contains no `secrets.` references, and no step receives Cloudflare credentials

#### Scenario: Agent cannot use the token
- **WHEN** the coding agent and tests are running
- **THEN** no GitHub token with write scope exists anywhere in the `build` job, and no GitHub token is present in `.git/config` or in the agent step's environment

#### Scenario: Build job permissions
- **WHEN** Code Reviewer inspects the `build` job
- **THEN** its `permissions` block is exactly `contents: read`, and none of its steps reference `github.token` or `GH_TOKEN`

## ADDED Requirements

### Requirement: Publish runs in a separate job
Pushing the branch, opening or updating the PR, and labeling SHALL happen only in a `publish` job on `ubuntu-latest` that `needs` the `build` job and runs only when `build` succeeded. `publish` MUST check out `github.sha`, the same base `build` used. It MUST NOT run `npm`, `npx`, `node`, tests, or any file taken from the artifact. It MUST NOT read `needs.build.outputs`.

#### Scenario: Environment poisoning in build
- **WHEN** model-written code in `build` writes a fake `git.exe` directory to `GITHUB_PATH` and sets `GIT_*` variables through `GITHUB_ENV`
- **THEN** the `publish` job's environment and `PATH` are unaffected, and no write token is ever present on the self-hosted runner

#### Scenario: Lingering process
- **WHEN** a test starts a background process that is still running after `build` ends
- **THEN** the process has no access to any write-scoped token, because `publish` runs on a separate GitHub-hosted VM

#### Scenario: Successful run
- **WHEN** `build` succeeds and its artifact passes validation
- **THEN** `publish` commits the files on `local-builder/issue-<N>` from `github.sha`, pushes with a lease, and opens (or reuses) the PR with the label, title prefix, and stats block

### Requirement: Build artifact is untrusted input
The `publish` job SHALL treat the `build` artifact as untrusted data. It MUST re-derive the change ID, task numbers, and allowed file list from the event payload, from `start`'s outputs, and from `tasks.md` at `github.sha`. It MUST reject the artifact, and push nothing, if any of the following hold: a path is not in that allowed list, a path is forbidden or unsafe, a path is duplicated, the base sha differs from `github.sha`, the change ID differs, a hash or size doesn't match, the artifact contains unlisted files, a size limit is exceeded, a stats value is outside its fixed set, the manifest has an unknown key, or the target path is a symlink. After writing the files, the git diff MUST match the manifest's paths exactly. The PR title, body, and commit message MUST be built from trusted values and the enumerated stats only.

#### Scenario: Unlisted path in artifact
- **WHEN** the manifest includes `src/other.ts`, which is not in the selected tasks' `Files:` list
- **THEN** `publish` fails with "artifact rejected", nothing is pushed, and the issue gets a failure comment

#### Scenario: Forbidden path in artifact
- **WHEN** the manifest includes `.github/workflows/x.yml` or `../x`
- **THEN** `publish` rejects the artifact and pushes nothing

#### Scenario: Wrong base
- **WHEN** the manifest's `base_sha` is not `github.sha`
- **THEN** `publish` rejects the artifact and pushes nothing

#### Scenario: Tampered content
- **WHEN** a blob's SHA-256 does not match its manifest entry, or the artifact contains a file the manifest doesn't list
- **THEN** `publish` rejects the artifact and pushes nothing

#### Scenario: Injected PR text
- **WHEN** the artifact contains free text in a stats field
- **THEN** `publish` rejects it, because stats values must come from fixed sets

### Requirement: Failure reporting from a GitHub-hosted job
Failure comments and labels for `build` and `publish` failures SHALL be posted by a `report` job on `ubuntu-latest` with `issues: write`. It runs when `start` succeeded and `publish` did not succeed. Text from the `build` report artifact MUST be treated as untrusted: size-capped, token-redacted, `@` mentions neutralized, workflow-command lines neutralized, and fenced safely. If the artifact is missing, a fixed fallback message MUST be posted. `report` MUST add `local-builder-failed` and remove `local-builder-running`.

#### Scenario: Ollama down
- **WHEN** the pre-flight check in `build` fails
- **THEN** `report` posts the "Ollama isn't reachable" reason on the issue and adds `local-builder-failed`, and no PR is opened

#### Scenario: Build cancelled before reporting
- **WHEN** `build` is cancelled or times out before it uploads the report artifact
- **THEN** `report` posts the fallback message with a link to the run and adds `local-builder-failed`

#### Scenario: Mention in a log excerpt
- **WHEN** the log excerpt contains `@someone`
- **THEN** the posted comment does not notify that user

#### Scenario: Publish rejects the artifact
- **WHEN** `publish` fails a validation check
- **THEN** `report` posts the fixed "artifact rejected: <check>" reason, and nothing was pushed
