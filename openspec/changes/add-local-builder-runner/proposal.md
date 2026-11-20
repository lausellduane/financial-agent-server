# Change: Add a local "additional builder" worker on Duane's old PC

> **Status: DRAFT v2 for Duane's approval.** Revised Fri Nov 20, 2026, 9:44 AM ET with Duane's answers.
> - Done in GitHub on Nov 20: the server repo's 3 settings, which Duane approved.
> - Not done yet: no runner, workflow, label, or token has been created, and nothing has been installed on the PC.
> - Target cost: **$0**.

## Why

Builder works by launching cloud coding agents. Small, well-specified cards (a one-file fix, a test, some copy) wait behind bigger work. Duane has an idle PC (i7-9700, 32 GB RAM, GTX 1660 Ti 6 GB, Windows 11 Pro) with Ollama already installed. If a free local coding agent picks up those small cards, it adds a second builder at no cost, and the review gates stay the same: Code Reviewer, then QA, then Duane merges.

Every local-builder PR is tracked, so we can measure whether it's actually worth it compared with Builder's PRs.

## What Changes

- **Self-hosted runner** on the old PC.
  - It runs as a Windows service under a dedicated **standard (non-admin) local user**, `ghrunner`, with the custom label `local-builder`.
  - It's registered to **`lausellduane/financial-agent-server` only**.
- **Workflow** `.github/workflows/local-builder.yml`, added later through a PR that Duane approves.
  - **Trigger:** only `issues: [labeled]`. The label must be `local-builder`, and both the labeler and the issue author must be `lausellduane`. It never runs on `pull_request`, `pull_request_target`, `push`, or fork events.
  - **Pre-flight:** it checks Ollama at `127.0.0.1:11434`. If Ollama is down, for example after a Windows Update reboot before Duane signs back in, it comments on the issue and stops.
  - **Warm-up:** it sends a short prompt so the model is loaded and fast before the agent starts.
  - **Agent run:** **Aider** runs against `qwen2.5-coder:7b` at **`num_ctx` 4096** (Duane measured it), with a small repo map. Aider reads `CONVENTIONS.md` plus the approved change's `tasks.md`. The job prompt is a fixed template, filled in only with the change path and task numbers and never with issue text.
  - **Output:** a PR on branch `local-builder/issue-<N>` with the `local-builder` label and a `[local-builder]` title prefix. The PR body ends with a **stats block**: model, attempts, run time, and whether tests passed on the first try. It never pushes to `master`.
  - **On failure** (stuck, failed, or no diff): it comments on the issue with the reason and a log excerpt, labels the issue `local-builder-failed`, and opens no PR.
- **Review-performance tracking:**
  - Search `label:local-builder` against Builder's PRs.
  - Compare them on Code Reviewer findings and QA first-pass results (design.md §10).
- **New draft files**, to be added to the repo in the workflow PR:
  - `conventions/CONVENTIONS.md`: the agent's rules.
  - `prompts/job-prompt.md`: the job prompt template.
- **GitHub settings** on financial-agent-server, **DONE Nov 20** and approved by Duane:
  - Ruleset `protect-master` (id 27731147): a PR is required with 0 approvals, no force push, no deletion, no bypass.
  - Fork-PR approval: `all_external_contributors`.
  - Default workflow permissions: `read`, with `can_approve_pull_request_reviews=true` (Actions may create PRs).
  - financial-agent-ui is **unchanged**.
- **Token:** the job's short-lived `GITHUB_TOKEN` only, with `contents: write`, `pull-requests: write`, and `issues: write`. No secrets. **Duane accepted the trade-off**: CI on the agent's PRs waits for his "Approve workflows to run".

## Impact

- **Repos:** both `lausellduane/financial-agent-server` and `lausellduane/financial-agent-ui` are **PUBLIC**, with `master` as the default branch.
  - GitHub says self-hosted runners "should almost never be used for public repositories".
  - Because of that, owner-only label triggers, no PR or fork triggers, and a hardened, secret-free PC user carry the risk (design.md §3).
- **Affected specs:** new capability `local-builder`.
- **Affected code:** one workflow file, `.aider.conf.yml`, `CONVENTIONS.md`, and the job prompt template. No app code.
- **Team process:**
  - Builder or Project Manager opens the issue and adds the label.
  - Code Reviewer and QA review against the spec scenarios. **QA tests before any merge, and Duane merges.**
  - Project Manager tracks local-builder PRs against Builder's PRs.
- **PC availability:** sleep is set to never, Duane stays signed in, and the screen turns off after 30 minutes, so jobs start right away. After a Windows Update reboot the runner service comes back on its own, but Ollama doesn't until Duane signs in. The pre-flight check covers that case.
- **CI/CD (server #7):**
  - The deploy workflow and Cloudflare secrets stay on GitHub-hosted runners.
  - Recommended: put the Cloudflare secrets in an Environment limited to `master`.
- **Cost:** $0. Self-hosted runner minutes, Ollama, and Aider are all free. The only cost is electricity.
- **Out of scope:** financial-agent-ui (until after the pilot), deploys, Durable Object migrations, auth, and deploy config.
