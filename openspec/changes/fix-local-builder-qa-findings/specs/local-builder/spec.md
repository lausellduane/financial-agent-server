# local-builder

## ADDED Requirements

### Requirement: Protected-path guard normalizes paths safely
The guard SHALL strip only a leading `./` from changed paths and MUST reject any path containing a `..` segment. Paths under `.git/`, `.github/`, `.env*`, `.dev.vars*`, `wrangler.*`, `migrations/`, and `*.pem`/`*.key` MUST be treated as forbidden.

#### Scenario: Dot-prefixed protected path
- **WHEN** the agent changes `.github/x`, `.git/config`, `.env`, or `.dev.vars`
- **THEN** the guard rejects the change and no PR is opened

#### Scenario: Parent-directory escape
- **WHEN** a changed path is `../escape.ts`
- **THEN** the guard rejects it as unsafe

#### Scenario: Ordinary relative path
- **WHEN** a changed path is `./src/a.ts`
- **THEN** it normalizes to `src/a.ts` and is allowed

### Requirement: Job token is not exposed to git hooks
The publish step SHALL commit with hooks disabled (`core.hooksPath=NUL`, `--no-verify`) and MUST NOT have `GH_TOKEN` in its environment during commit. The token SHALL be available only to the push and PR-create operations.

#### Scenario: Agent plants a pre-commit hook
- **WHEN** the working tree contains a hook that reads `GH_TOKEN`
- **THEN** the hook does not run during commit and the token is not exposed

### Requirement: Every workflow step is time-bounded
Every step in `local-builder.yml` SHALL set `timeout-minutes`, and steps other than the Aider attempts MUST use 10 minutes or less.

#### Scenario: A step hangs
- **WHEN** any non-Aider step stops responding
- **THEN** it is cancelled within 10 minutes and the failure comment runs

### Requirement: Retry after a timed-out first attempt
When Aider attempt 1 ends as `success`, `failure`, or `cancelled`, the workflow SHALL evaluate it and run attempt 2 if needed, unless `BLOCKED.md` exists.

#### Scenario: Attempt 1 times out
- **WHEN** attempt 1's outcome is `cancelled` and no `BLOCKED.md` exists
- **THEN** attempt 2 runs

#### Scenario: Agent reports blocked
- **WHEN** `BLOCKED.md` exists
- **THEN** attempt 2 is skipped

### Requirement: Relabel retry with an existing branch
When `local-builder/issue-N` already exists on origin, the workflow SHALL recreate that branch from freshly fetched `origin/master`.

#### Scenario: Duane relabels an issue
- **WHEN** the branch from a prior run exists
- **THEN** the branch is recreated from fresh `origin/master` and the run proceeds

### Requirement: Guard diffs against the branch base
`Get-ChangedFiles` SHALL diff against the same base ref the branch was created from.

#### Scenario: Local master is stale
- **WHEN** local `master` is behind freshly fetched `origin/master`
- **THEN** only the agent's changes are reported to the guard
