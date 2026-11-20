# Design: Local builder runner

**v2, revised Nov 20, 2026, 9:44 AM ET with Duane's answers.** All commands and flags below were checked against current docs on Nov 20, 2026 (sources at the end). Where something wasn't verified, it's marked **[unverified]**. No version numbers are pinned on purpose. Use whatever the official download page or package manager shows on install day.

---

## Plain-words box: the cloud and CI ideas here (with AWS Cloud Practitioner tie-ins)

- **Runner:** the computer that actually runs a GitHub Actions job.
  - **GitHub-hosted runners** are fresh VMs that GitHub creates for each job and throws away afterward. They're clean every time, and GitHub patches them.
  - **Self-hosted runners** are your own machine. It isn't wiped between jobs, and anything a job does (files, installed tools, malware) can stay behind.
  - *AWS tie-in, the shared responsibility model:* GitHub-hosted is like a managed service such as Lambda, where AWS secures the host. Self-hosted is like EC2, where **you** own OS patching, users, and firewall. Moving to self-hosted moves responsibility onto Duane.
- **Least privilege:** give each identity only the permissions its task needs, for only as long as it needs them.
  - Here, the job token can write branches, PRs, and issue comments for one repo, and it can't edit workflows or read deploy secrets.
  - *AWS tie-in:* this is the IAM best practice of least-privilege policies. A short-lived `GITHUB_TOKEN` that expires when the job ends is like an **IAM role with temporary STS credentials**. A long-lived PAT is like an **IAM user access key**, which AWS tells you to avoid.
- **Blast radius and isolation:** a dedicated non-admin Windows user, one repo, and no secrets mean a bad job can only damage a little.
  - *AWS tie-in:* separate accounts and roles per workload, and "security **of** the cloud vs **in** the cloud".
- **Kill switch:** stop the service, or just don't add the label. That's like disabling an IAM key or setting a Lambda's concurrency to 0.

---

## 1. Runner install: Windows service, low-privilege user, cleanup

**Decision:** use a repo-level runner, installed as a Windows service, running as a dedicated **standard** local user `ghrunner`. Duane's account doesn't run it, and neither does an admin or LocalSystem.

- **Install dir:** `C:\actions-runner`. **Work dir:** `_work`, the default, which is relative and so resolves to `C:\actions-runner\_work`.
- **Permissions:**
  - `ghrunner` gets Modify on `C:\actions-runner` only.
  - It gets no access to `C:\Users\<Duane>`. Windows already blocks other users' profiles by default; confirm this.
- **Registration:** run from an **elevated** PowerShell, because installing a service needs admin. The *service* itself runs as `ghrunner`. The flags were verified against `config.cmd --help` output posted in actions/runner#323.

```powershell
cd C:\actions-runner
.\config.cmd --unattended `
  --url https://github.com/lausellduane/financial-agent-server `
  --token <REGISTRATION_TOKEN_FROM_SETTINGS_ACTIONS_RUNNERS> `
  --name old-pc-local-builder `
  --labels local-builder `
  --work _work `
  --runasservice `
  --windowslogonaccount ".\ghrunner" `
  --windowslogonpassword "<ghrunner password>"
```

- **Labels:** the default labels `self-hosted, Windows, X64` are kept, and `local-builder` is added.
  - The workflow uses `runs-on: [self-hosted, local-builder]`.
  - That way no other workflow lands here by accident, because ordinary workflows ask for `ubuntu-latest`.
- **Registration token:** it comes from repo **Settings → Actions → Runners → New self-hosted runner**. It's short-lived and used once, and it isn't stored anywhere afterward.
- **Service control:**
  - `Get-Service "actions.runner.*"` and `Stop-Service "actions.runner.*"` / `Start-Service "actions.runner.*"` work, per the GitHub docs.
  - On Windows, the service can only be set up during `config.cmd`. To change the account later, run `.\config.cmd remove` and register again.
- **Runner groups:** these exist only for organizations and enterprises. Duane's repos are under a personal account, so the **repo-level registration is the scope boundary**, and no group is needed.
- **Auto-update:** keep the default. Don't use `--disableupdate`, so the runner gets security fixes.
- **Ephemeral-style cleanup:**
  - `--ephemeral` exists: the runner takes one job and then de-registers. Each new registration needs a fresh token, though, and automating that needs a PAT or admin API token, which breaks the no-secrets rule.
  - **Decision:** use a persistent runner plus forced cleanup.
    - `actions/checkout` runs with `clean: true`, which is the default.
    - A final `if: always()` step deletes `$env:GITHUB_WORKSPACE\*`, Aider's cache and history files, and `$env:RUNNER_TEMP\*`.
    - A weekly Windows scheduled task, running as Duane, wipes `C:\actions-runner\_work\*` while the service is stopped.
  - Revisit JIT or ephemeral runners after the pilot if needed.
- **Ollama access from `ghrunner`:**
  - Ollama listens on `127.0.0.1:11434` (Ollama FAQ). Any local user can reach that port, so the runner user doesn't need Duane's profile.
  - Ollama on Windows runs as a **tray app under Duane's login**.
  - **Power (Duane's answer):**
    - Sleep is set to **never**, and only the screen turns off, after 30 minutes. Duane stays signed in, so jobs start right away.
    - After a **Windows Update reboot**, the runner service starts again at boot without anyone signing in, but **Ollama doesn't come back until Duane signs in**.
    - A job can therefore be picked up while Ollama is down. The **pre-flight step** (§6) catches this, comments on the issue, and stops.

## 2. Repo scope

| Repo | Visibility | Default branch | `master` protection | Fork-PR approval | Workflow perms |
|---|---|---|---|---|---|
| lausellduane/financial-agent-server | **PUBLIC** | master | **DONE Nov 20 (approved by Duane):** ruleset `protect-master`, id 27731147. PR required, 0 approvals, no force push, no deletion, no bypass | **DONE Nov 20:** `all_external_contributors` | **DONE Nov 20:** default `read`, `can_approve_pull_request_reviews=true` (Actions may create PRs) |
| lausellduane/financial-agent-ui | **PUBLIC** | master | **unchanged:** not protected | **unchanged:** `first_time_contributors` | **unchanged:** `read`, create/approve PRs **off** |

Visibility and the UI repo's state come from `gh` on Nov 20. I recorded the server settings as Duane reported them; DevOps didn't make those changes.

**Notes on the ruleset:**
- With **no bypass**, nobody can push to `master` directly, not even Duane or `github-actions[bot]`. Every change, including the workflow itself, goes through a PR.
- With **0 approvals required**, the "QA before merge" gate is a team rule, not something GitHub enforces. Duane is the only merger.
- `can_approve_pull_request_reviews=true` also lets a workflow *approve* PRs. The local-builder workflow **must never call approve**, and Code Reviewer checks for that.

**Decision:**
- The pilot runs on **financial-agent-server only**. Its tests run with `npm test` (the tsx tests, then `vitest run`).
- financial-agent-ui gets added only after a successful pilot, through a separate repo-level registration and the same three settings.
- The runner is never registered at the account level.

## 3. Security guardrails

GitHub's docs say: *"self-hosted runners should almost never be used for public repositories on GitHub, because any user can open pull requests against the repository and compromise the environment."* Both repos are public, so the design makes sure **no outsider-controlled event can ever schedule a job on this runner**.

| Risk | Guardrail |
|---|---|
| Outsider opens a fork PR that runs on the PC | The workflow has **no** `pull_request`, `pull_request_target`, `push`, `workflow_run` or `issue_comment` triggers. Only `issues: labeled`. Fork-PR approval is **set to `all_external_contributors` (DONE Nov 20)**. Also, **no other workflow in the repo may use `self-hosted`** (Code Reviewer checks this on every workflow PR). |
| Someone else adds the label | On a public repo, only people with triage or write access can label, and Duane is the only collaborator **[confirm]**. The job-level `if:` also requires `github.event.label.name == 'local-builder'` **and** `github.event.sender.login == 'lausellduane'` **and** `github.event.issue.user.login == 'lausellduane'`. |
| Prompt or script injection from issue text | Issue title and body text is **never** put inside `${{ }}` in a `run:` script. It's passed via `env:` only. The only thing read from the body is a change ID matched against `^[a-z0-9-]+$`. The agent's instructions come from `openspec/changes/<id>/` **on master**, which is approved, reviewed content, not from the issue. |
| Secrets leak | No repo, env, or org secrets are referenced in this workflow. Nothing on the PC: no Cloudflare token, no `wrangler login`, no PATs, no SSH keys in the `ghrunner` profile. Recommend moving the Cloudflare deploy secrets (from #7) into a GitHub **Environment** `production` restricted to `master`, so a workflow on any other branch can't read them. |
| Over-powered token | **Decision: job `GITHUB_TOKEN`, not a fine-grained PAT.** The workflow sets `permissions: {}` at the top and gives the job only `contents: write`, `pull-requests: write`, `issues: write`. Reasons: it's created per job and **expires when the job ends**; it's scoped to this one repo automatically; there's nothing to store or rotate; and it can **never** get the `workflows` permission, so pushes that change `.github/workflows/**` are rejected by GitHub. *Trade-off, **accepted by Duane on Nov 20**:* PRs opened with `GITHUB_TOKEN` don't run CI on their own. CI waits for Duane to click "Approve workflows to run", or for him to close and reopen the PR. A fine-grained PAT would trigger CI automatically, but it's a long-lived stored secret, so it was rejected. "Allow Actions to create PRs" is **on (DONE Nov 20)**. |
| Agent token reuse | `actions/checkout` with `persist-credentials: false`, so the token isn't left in `.git/config` while Aider and the tests run. The token is given only to the final push and `gh pr create` steps via `env: GH_TOKEN`. |
| Direct push to master | Ruleset `protect-master` (id 27731147, **DONE Nov 20**) requires a PR, blocks force pushes and deletion, and allows **no bypass**. The workflow also only pushes `HEAD:refs/heads/local-builder/issue-<N>` and fails if the branch name isn't in that form. |
| Agent edits sensitive files | A pre-push diff check fails the job if any changed path matches `.github/**`, `wrangler.*`, `**/migrations/**`, `package.json`/`package-lock.json` (unless the task allows it), `.env*`, `*.pem`. Belt and braces with the token's missing `workflows` permission. |
| Ollama exposed to the LAN | Keep `OLLAMA_HOST` unset (default `127.0.0.1:11434`) or set it explicitly to `127.0.0.1:11434`, **never** `0.0.0.0`. Add a Windows Firewall inbound **block** rule for TCP 11434 as a backstop. |
| Malicious code run by the tests | The agent's diff runs locally via `npm test`, so a bad diff executes as `ghrunner`. Mitigations: a non-admin user, no secrets, no access to Duane's profile, and a workspace wiped after every job. Keep sensitive files off the PC entirely (GitHub's guidance). |
| `npm ci` lifecycle scripts | Server: `npm ci` (no `postinstall` today). UI (later): needs its `postinstall`, so review before enabling. |
| Ollama down after a reboot | The pre-flight step (§6) checks `http://127.0.0.1:11434/api/tags` and confirms the model is listed. If not, it comments on the issue ("Ollama isn't reachable on the PC. Duane may need to sign in after a Windows Update reboot.") and adds `local-builder-failed`. No agent runs. |
| **Kill switch** | 1) `Stop-Service "actions.runner.*"` (instant; jobs queue and expire after 24 h). 2) Remove or don't add the `local-builder` label. 3) Disable the workflow (Actions → workflow → "Disable workflow"). 4) Settings → Actions → Runners → remove the runner. |

## 4. Model choice (6 GB VRAM)

**Duane's measurements** (Nov 20) for `qwen2.5-coder:7b` at **num_ctx 4096**:

| | Value |
|---|---|
| Loaded size (`ollama ps`) | **5.2 GB** |
| CPU/GPU split | **18% / 82%**, so some CPU offload even at 4K |
| Cold first run | prompt eval **1.26 tok/s**, eval **6.74 tok/s** (model loading dominates) |
| Warm | prompt eval **142 tok/s**, eval **17.8 tok/s** |

**Decision: `qwen2.5-coder:7b` at `num_ctx` 4096. Not 8192.**
- At 4K the model already spills 18% to the CPU. 8K would add about 0.45 GB of KV cache (my estimate, not measured) and push more layers onto the CPU.
- Warm speed is fine for small cards:
  - A full 4K prompt takes about 30 s to read.
  - A reply of about 1,500 tokens takes about 85 s to write.
- Cold speed isn't fine. That's why the workflow has a **warm-up step** (§6), which loads the model with the **same num_ctx** and a `keep_alive`. If the num_ctx differed, Ollama would reload the model.

**Fitting into 4K tokens** is the main constraint:
- **Aider repo map:** `--map-tokens 0` turns it off; the agent gets the named files instead. `--map-tokens 256` is the most to allow.
- **Read-only context:** only `CONVENTIONS.md` and the change's `tasks.md`.
  - The spec is **not** passed whole. The job prompt quotes only the scenario headings for the tasks being run, taken from `master`.
- **Edit format:**
  - `whole` rewrites the full file, so input file plus output file must fit. Use it only for files under about 80 lines.
  - Use `diff` (search/replace blocks) for longer files.
  - The workflow picks the format from the file's line count.
- **Size budget check:** before Aider runs, the workflow estimates tokens as characters ÷ 4 across the prompt, the read files, and the edit files. If the estimate is over about 2,500, it fails with "task too large for 4K context". That leaves room for Aider's system prompt and the reply.
- **Pinning num_ctx:**
  - Set `OLLAMA_CONTEXT_LENGTH=4096` as a user environment variable on Duane's account, where the Ollama tray app runs.
  - Also set `num_ctx: 4096` under `extra_params` in `.aider.model.settings.yml`.
  - Check during the test run that `ollama ps` shows 4096. Aider may set num_ctx for Ollama itself; that behavior is **[unverified]**.

**Alternatives** (sizes from ollama.com tag pages, checked Nov 20):

| Model | Size | Verdict |
|---|---|---|
| `qwen2.5-coder:3b` | 1.9 GB | **Fallback.** Fully on GPU, faster, and fits a larger context, but weaker at edits. Switch to it if the 7b keeps timing out. |
| `qwen3:8b` | 5.2 GB file | Bigger than the 7b, so more offload. Its thinking tokens eat into the 4K context. No. |
| `deepseek-coder-v2:16b` lite | 8.9 GB (q2_K is 6.4 GB) | Too big. |
| `qwen3-coder` | smallest is 30b, 19 GB | Too big. |
| `qwen2.5-coder:14b` | 9.0 GB | Only with the RTX 3060. |

**What an RTX 3060 12 GB would unlock:**
- The 7b fully on GPU, with **8K–16K+ context**.
- Or `qwen2.5-coder:14b` / `qwen3:14b` at 8K.
- Repo map and spec context could come back, two-file cards would fit, and OpenCode's tool-calling approach would become an option.

## 5. Agent choice: Aider vs OpenCode

| | **Aider** | **OpenCode** |
|---|---|---|
| Headless use | `aider --message-file prompt.md --yes-always` does one task and exits. Verified flags: `--message/-m`, `--message-file/-f`, `--yes-always`, `--no-pretty`, `--no-stream`, `--no-fancy-input`, `--analytics-disable`, `--no-check-update`, `--show-model-warnings` | `opencode run "<prompt>"` sends one message and exits; `-m provider/model`; permission auto-approve flags differ between v1 and v2 **[flag names vary by major version, not pinned]** |
| Ollama setup | `--model ollama_chat/qwen2.5-coder:7b` plus `OLLAMA_API_BASE=http://127.0.0.1:11434` (Aider docs recommend `ollama_chat/` over `ollama/`) | v1: provider block in `opencode.json` (`@ai-sdk/openai-compatible`, `baseURL http://localhost:11434/v1`); v2 docs say it auto-discovers local Ollama. The **config schema changed between versions**, which is fragile for CI |
| How edits happen | The model returns text edits (`whole`, `diff`, `udiff` formats); **no tool calling needed** | Agentic **tool calling** (read, edit, bash). 7B models are unreliable at this, and OpenCode's own tip is to raise `num_ctx` to 16K–32K when tool calls fail, which doesn't fit 6 GB |
| Small-model reliability | Good with `--edit-format whole` on small files, since the model just rewrites the file. Use `diff` for longer files, because of the 4K limit (§4). The format is pinned rather than left to Aider's default **[default edit format for this Ollama model not verified]** | Weaker at 7B / 8K ctx |
| Git behavior | Auto-commits every edit by default; `--no-auto-commits` and `--no-dirty-commits` turn that off. It **never pushes**. Note: it skips git hooks by default (`--no-verify`); `--git-commit-verify` turns hooks back on | Doesn't commit by itself; the workflow would commit |
| Test loop | `--test-cmd "npm test" --auto-test` feeds failures back to the model; also `--lint-cmd` / `--auto-lint` | It can run bash itself (a bigger permission surface on the runner) |
| Windows install | `python -m pip install aider-install` then `aider-install` (installs its own Python 3.12 environment if needed). It must be done **as `ghrunner`** so it's on that user's PATH | `npm install -g opencode-ai` (or scoop) |

**Decision: Aider.**
1. It doesn't depend on tool calling, which is the weakest skill of 7B models.
2. It has stable, documented scripting flags.
3. It can't run arbitrary shell commands on its own, so it's a smaller blast radius than an agent with a bash tool.
4. Its built-in test feedback loop helps.

Revisit OpenCode after a GPU upgrade.

Invocation sketch (Aider, inside the workflow; the workflow makes the single commit):

```powershell
aider --model ollama_chat/qwen2.5-coder:7b --edit-format $env:EDIT_FORMAT `
  --no-auto-commits --no-dirty-commits --yes-always `
  --no-pretty --no-stream --no-fancy-input --analytics-disable --no-check-update `
  --map-tokens 0 `
  --read "conventions/CONVENTIONS.md" `
  --read "openspec/changes/$env:CHANGE_ID/tasks.md" `
  --test-cmd "npm test" --auto-test `
  --message-file "$env:RUNNER_TEMP\job-prompt.md" `
  <files listed under "Files:" for the selected tasks>
```

`$env:EDIT_FORMAT` is `whole` for files under about 80 lines and `diff` otherwise. `job-prompt.md` is rendered from the repo template `prompts/job-prompt.md`. The template has only these placeholders: `{{CHANGE_PATH}}`, `{{TASK_NUMBERS}}`, `{{FILES}}`, `{{SCENARIOS}}`, `{{ATTEMPT}}`, `{{TEST_FAILURE_EXCERPT}}`. Each value comes from the change on `master`, from the workflow itself, or from the repo's own test output. **No issue text is ever included.**

## 6. Workflow shape, timeouts, tracking, and failure handling

This sketch is illustrative only. It isn't created until a later PR is approved. The issue body may contain only two lines that the workflow reads, each checked with a strict regex:
- `openspec-change: <id>` (`^[a-z0-9-]+$`)
- an optional `tasks: 1.1,1.2` (`^[0-9.,]+$`)

If `tasks` is missing, the workflow runs all unchecked tasks in `tasks.md`. Nothing else from the issue is used.

```yaml
name: local-builder
on:
  issues:
    types: [labeled]
permissions: {}
concurrency: { group: local-builder, cancel-in-progress: false }
jobs:
  build:
    if: >-
      github.event.label.name == 'local-builder' &&
      github.event.sender.login == 'lausellduane' &&
      github.event.issue.user.login == 'lausellduane' &&
      github.event.issue.pull_request == null
    runs-on: [self-hosted, local-builder]
    timeout-minutes: 60
    permissions: { contents: write, pull-requests: write, issues: write }
    env:
      ISSUE_NUMBER: ${{ github.event.issue.number }}
      ISSUE_BODY: ${{ github.event.issue.body }}   # read via $env only, never inlined in scripts
      OLLAMA_API_BASE: http://127.0.0.1:11434
      MODEL: qwen2.5-coder:7b
      NUM_CTX: "4096"
    defaults: { run: { shell: powershell } }
    steps:
      - # record start time; swap issue label local-builder -> local-builder-running (gh, GH_TOKEN)
      - # PRE-FLIGHT (timeout-minutes: 2): GET http://127.0.0.1:11434/api/tags, must list $env:MODEL.
        # On failure: comment "Ollama isn't reachable at 127.0.0.1:11434 on the local builder PC. Duane may need to sign in after a Windows Update reboot." -> label local-builder-failed -> exit 1
      - # parse change id + task numbers (strict regex); require openspec/changes/<id>/tasks.md on master
      - uses: actions/checkout@<pin to a full commit SHA on install day>
        with: { persist-credentials: false, clean: true }
      - # WARM-UP (timeout-minutes: 5): POST /api/generate {model, prompt:"Reply OK", stream:false, keep_alive:"30m", options:{num_ctx:4096}}
        # Same num_ctx as the agent, so Ollama doesn't reload. Cold load measured at ~1.3 tok/s prompt eval; this absorbs it.
      - # npm ci (timeout-minutes: 10)
      - # render prompts/job-prompt.md -> $env:RUNNER_TEMP\job-prompt.md; context-budget check (~2,500 est. tokens max)
      - # aider attempt 1 (timeout-minutes: 25); record TESTS_FIRST_TRY = pass/fail
      - # if tests fail or no diff -> aider attempt 2 with test-failure excerpt in {{TEST_FAILURE_EXCERPT}} (timeout-minutes: 25)  [MAX_ATTEMPTS = 2]
      - # guard: diff non-empty; only listed files; no forbidden paths; no BLOCKED.md; npm test passes (timeout-minutes: 10)
      - # commit; push HEAD:refs/heads/local-builder/issue-$env:ISSUE_NUMBER
      - # gh pr create --base master --head local-builder/issue-N --label local-builder
        #   --title "[local-builder] <change id>: tasks <n>" --body-file pr-body.md  (body ends with the stats block below)
      - if: failure() || cancelled()
        # gh issue comment: reason + last ~40 log lines (or BLOCKED.md text); labels: -running +local-builder-failed; no PR
      - if: always()
        # cleanup: delete workspace contents, .aider* files, RUNNER_TEMP
```

**PR tracking.** Every local-builder PR has all three of these markers:
1. Branch `local-builder/issue-<N>`.
2. Title prefix `[local-builder]`.
3. Label `local-builder`. Labeling a PR fires `pull_request`, not `issues`. Even if it did fire this workflow, the actor is `github-actions[bot]`, so the `if:` guard skips it, and the `issue.pull_request == null` check is a second guard.

The PR body ends with this stats block, always in the same shape so it's easy to parse:

```markdown
<!-- local-builder-stats -->
### Local builder stats
| Field | Value |
|---|---|
| Model | qwen2.5-coder:7b (num_ctx 4096) |
| Attempts | 1 of 2 |
| Run time | 14m 32s (job start → PR opened) |
| Tests passed on first try | yes |
| Edit format | whole |
| Files changed | 1 |
| Issue / change | #N / openspec/changes/<id> |
```

- **Limits:**
  - **Job:** `timeout-minutes: 60`.
  - **Per step:** pre-flight 2, warm-up 5, install 10, each Aider attempt 25, verify 10.
  - **Attempts:** at most **2**.
  - **Ollama requests:** set Aider's `--timeout` high, for example 600 s.
- **When it's stuck or fails** (timeout, tests still failing, no diff, forbidden path, over the context budget, Ollama down, or the agent wrote `BLOCKED.md`):
  - It comments on the issue with a one-line reason and a short excerpt.
  - It removes `local-builder-running` and adds `local-builder-failed`.
  - It **opens no PR**, and nothing is pushed.
  - To retry, Duane or a bot fixes the spec and re-adds the label.
- **Queued jobs:** if the runner service is stopped, jobs stay queued and GitHub fails them after 24 h. Project Manager flags issues still labeled `local-builder` after one day.

## 7. Which cards suit it

**Good fits.** Every one needs an approved OpenSpec change with a `Files:` list and WHEN/THEN scenarios. Because of the 4K context, the target file should be about 300 lines or less, and the whole job (prompt, conventions, tasks, file) has to pass the about-2,500-token budget check:
- Single-file bug fixes with a clear repro scenario. For example, #9 LOW: an unsigned `RETURN DIRECT DEPOSIT` subtracts from income, once Duane decides the rule.
- Adding or extending unit tests for existing functions.
- Copy, prompt text, or label changes. For example, #9 LOW: the question-reading prompt doesn't mention "Other money in".
- Small pure-function changes such as parsing or formatting, plus their tests.

**Not suited** (keep with Builder and cloud agents):
- Durable Object classes or migrations, and storage schema changes.
- Auth, sessions, tokens, CORS, or anything security-sensitive.
- Deploy config: `wrangler.*`, `.github/workflows/**`, CI, bindings, secrets.
- Multi-file features, UI flows and Expo/React Native screens, dependency upgrades.
- Anything with vague acceptance criteria, or that needs product decisions.

## 8. Pilot

- **Repo:** financial-agent-server.
- **Card:** one card only. Proposed: *"Mention the 'Other money in' category in the question-reading prompt"* (Code Reviewer's optional LOW from #9). It's one file, mostly text, and low risk.
- **Steps:**
  1. Run **dry failure tests** first:
     - an issue pointing at a nonexistent change ID;
     - a run while Ollama is quit from the tray, which tests the pre-flight step.
     Each must comment, label `local-builder-failed`, and open no PR.
  2. Then run the real card.

**Pilot success criteria** (all must hold):
1. Only Duane's label triggers it. A test label added by any other identity, or a different label, doesn't start a job (check the Actions tab).
2. A PR from `local-builder/issue-<N>` to `master` opens within 60 minutes. It has the `local-builder` label, the `[local-builder]` title prefix, and a complete stats block. Nothing is pushed to `master`.
3. The diff touches only the files listed in tasks.md, and there are no forbidden paths.
4. `npm test` passes on the PC and in GitHub-hosted CI after "Approve workflows to run".
5. Code Reviewer finds no HIGH or MEDIUM issues, and QA passes every spec scenario. Then Duane merges.
6. The failure path works: a comment with a reason, the `local-builder-failed` label, and no PR.
7. Afterward, `C:\actions-runner\_work` is empty, `netstat -ano | findstr 11434` shows Ollama listening on 127.0.0.1 only, and no secrets exist on the PC or in the workflow.
8. Cost is $0.

If criteria 1, 2, 3 or 7 fail, stop the service and revisit before any second card.

## 9. Open questions for Duane

Already answered and removed: the token trade-off (accepted), the three server settings (done), and Ollama uptime and power (never sleeps, stays signed in).

1. **Who presses the trigger?** The guard checks that `sender.login == lausellduane`. If Builder or Project Manager add the label using your GitHub login, the guard can't tell them apart from you. Is it OK for the bots to trigger it, or should only you add the label by hand?
2. **Where OpenSpec changes live:** financial-agent-server has no `openspec/` folder on `master` yet. Should approved changes, plus `conventions/` and `prompts/`, be committed to the repo? The workflow assumes they are, and with `protect-master`, that also happens through PRs.
3. **Pilot card:** is "mention 'Other money in' in the question-reading prompt" the right first card? The money-in rule cards (INTEREST PAYMENT, RETURN DIRECT DEPOSIT) wait on your decision.
4. **Windows Update restarts:** should you set Active hours, or pause auto-restart, so Ollama is down less often? The pre-flight check handles it either way.
5. **Required checks:** once CI #7 merges, should `protect-master` also require its checks to pass? Agent PRs would then need your "Approve workflows to run" before they can merge, which matches the accepted trade-off.
6. **Cloudflare secrets:** may I move them into a `production` Environment limited to `master` as part of CI/CD #7?
7. **UI repo:** should financial-agent-ui get the same three settings and its own runner registration after a successful pilot?
8. **GPU upgrade:** if the RTX 3060 12 GB happens, raise num_ctx to 8K+ (or switch to the 14b) and widen card scope then?

## 10. Review performance: local builder vs Builder

**Goal:** after the pilot and roughly the next 5–10 local-builder PRs, decide whether the local builder is worth keeping, using the same review data Builder's PRs already produce.

**Finding the two sets of PRs:**
```bash
# Local builder PRs
gh pr list --repo lausellduane/financial-agent-server --state all --search "label:local-builder" \
  --json number,title,createdAt,mergedAt,closedAt,additions,deletions,changedFiles,body
# Builder's PRs, same repo and period
gh pr list --repo lausellduane/financial-agent-server --state all --search "-label:local-builder created:>=2026-11-20" \
  --json number,title,createdAt,mergedAt,closedAt,additions,deletions,changedFiles
```
On GitHub's web UI, the same searches are `is:pr label:local-builder` and `is:pr -label:local-builder`. The branch prefix and title prefix work as backups if a label is ever missing.

**What to compare for each PR**, and where it comes from:

| Metric | Source |
|---|---|
| Code Reviewer findings by severity (HIGH/MEDIUM/LOW), and the number of review rounds | Code Reviewer's report for that PR (chat, PR comment, or card) |
| QA result on the first test pass (pass/fail), and the number of QA rounds | QA Engineer's report |
| Merged / closed without merge / still open | `mergedAt`, `closedAt` |
| Time from PR opened to merged | `createdAt` → `mergedAt` |
| Diff size | `additions + deletions`, `changedFiles` |
| Attempts, run time, tests first try (local builder only) | Parsed from the `<!-- local-builder-stats -->` block in `body` |
| Failed runs that opened no PR | Issues labeled `local-builder-failed` (`gh issue list --search "label:local-builder-failed"`) |

**How to read it:**
- Compare only **similar-sized cards**, meaning one or two files under about 50 changed lines. Builder's bigger features would skew the numbers.
- **Keep the local builder** if, across about 10 runs, all of these hold:
  - It averages no more than 1 MEDIUM finding per PR, with 0 HIGH.
  - QA first-pass rate is at least 70%.
  - Fewer than 3 runs fail without a PR.
- **Otherwise,** tighten the card criteria, try the 3b or a better GPU, or retire it.

Project Manager collects this in the weekly standup. DevOps can write a small script to pull the `gh` data and stats blocks, after approval.

## Sources checked (Nov 20, 2026)
- GitHub Docs: *Configuring the self-hosted runner application as a service* (Windows: service set up during config; `Start/Stop/Get-Service "actions.runner.*"`).
- actions/runner#323: `config.cmd --help` output (`--unattended --url --token --name --runnergroup --labels --no-default-labels --work --replace --disableupdate --ephemeral --runasservice --windowslogonaccount --windowslogonpassword`).
- GitHub Docs: *Secure use reference* → "Hardening for self-hosted runners"; *Self-hosted runners reference* (ephemeral, 24 h queue).
- GitHub Docs: *Managing GitHub Actions settings for a repository* (fork-PR approval options; "Allow GitHub Actions to create and approve pull requests"; default `GITHUB_TOKEN` read-only for personal repos).
- GITHUB_TOKEN-triggered PR events don't auto-run workflows (GitHub docs, summarized in third-party write-ups).
- Duane's own measurements of `ollama ps` and token rates (Nov 20), and the server repo settings he reported as done (Nov 20).
- Aider docs: Ollama, Scripting, Options reference (flags grepped from the live page), Edit formats.
- OpenCode docs: CLI `run`, Providers (Ollama); Ollama docs: OpenCode integration.
- Ollama FAQ (default ctx 4096, `OLLAMA_CONTEXT_LENGTH`, binds 127.0.0.1:11434, Windows env vars); ollama.com tag pages for sizes.

## Decisions (Duane, Nov 20, 2026)

- The bots may add the `local-builder` label under Duane's login.
- OpenSpec changes live in `openspec/` in each repo (this PR).
- Pilot card: add "Other money in" to the question-reading prompt (Code Reviewer's leftover LOW from #9).
- Windows Update active hours will be set manually on the PC, with "Get me up to date" off.
- After #7 merges: require CI checks in `protect-master`, and move the Cloudflare secrets into a `production` environment limited to `master`.
- The UI repo gets added after the pilot succeeds.
- No GPU upgrade for now; stay on `qwen2.5-coder:7b` at a 4096 context.
