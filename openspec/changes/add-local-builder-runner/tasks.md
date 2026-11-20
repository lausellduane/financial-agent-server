# Tasks: add-local-builder-runner (v2)

> - **[Duane]** = Duane does it himself on the PC or in GitHub settings.
> - **[PR]** = a repo change through a normal PR. Code Reviewer reviews it, and Duane merges. `protect-master` means every repo change goes this way.
> - **[Team]** = done by the bots after approval.
>
> Nothing in sections 2–4 starts until Duane approves this change.

## 1. Approvals and GitHub settings
- [ ] 1.1 [Duane] Approve this proposal: the pilot repo `financial-agent-server`, Aider with `qwen2.5-coder:7b` at num_ctx 4096, and the tracking and conventions files.
- [x] 1.2 [Duane] **DONE Nov 20.** Ruleset `protect-master` (id 27731147) on financial-agent-server: PR required (0 approvals), no force push, no deletion, no bypass.
- [x] 1.3 [Duane] **DONE Nov 20.** Fork-PR approval set to `all_external_contributors` on financial-agent-server.
- [x] 1.4 [Duane] **DONE Nov 20.** Default workflow permissions stay `read`, and `can_approve_pull_request_reviews=true` (Actions may create PRs) on financial-agent-server.
- [x] 1.5 [Duane] **Decided Nov 20:** the job uses `GITHUB_TOKEN`, not a PAT. CI on agent PRs waits for Duane's "Approve workflows to run".
- [ ] 1.6 [Duane] Create the labels `local-builder` (used on both issues and PRs), `local-builder-running`, and `local-builder-failed`.
- [ ] 1.7 [Duane] Confirm he's the only collaborator with triage or write access.
- [ ] 1.8 [Team, then Duane] Optional: move the Cloudflare deploy secrets from #7 into Environment `production`, limited to `master`.
- [ ] 1.9 financial-agent-ui: **no change** until after the pilot.

## 2. Windows PC setup (Duane does these himself)
- [x] 2.1 **DONE (Duane):** sleep set to **never**, screen off after 30 min, stays signed in.
- [x] 2.2 **DONE (Duane):** `qwen2.5-coder:7b` pulled and measured. At 4096 ctx it loads at 5.2 GB, splits 18% CPU / 82% GPU, and runs at 142 tok/s prompt eval and 17.8 tok/s eval once warm.
- [ ] 2.3 Set the user environment variable `OLLAMA_CONTEXT_LENGTH=4096` on Duane's account. Leave `OLLAMA_HOST` unset, or set it to `127.0.0.1:11434`. Restart Ollama from the tray and check that `ollama ps` shows 4096.
- [ ] 2.4 Pull the fallback model: `ollama pull qwen2.5-coder:3b`.
- [ ] 2.5 Block LAN access to Ollama: `New-NetFirewallRule -DisplayName "Block Ollama inbound" -Direction Inbound -Protocol TCP -LocalPort 11434 -Action Block`. Then run `netstat -ano | findstr 11434` and check it shows `127.0.0.1:11434` only.
- [ ] 2.6 Create a standard (non-admin) local user in an elevated PowerShell:
  - `$pw = Read-Host -AsSecureString`
  - `New-LocalUser -Name ghrunner -Password $pw -PasswordNeverExpires -AccountNeverExpires`
  - Don't add it to Administrators.
- [ ] 2.7 Make the runner folder and lock it down: `mkdir C:\actions-runner`, then `icacls C:\actions-runner /grant "ghrunner:(OI)(CI)M"`.
- [ ] 2.8 Download the runner from repo **Settings → Actions → Runners → New self-hosted runner → Windows x64**. Use the exact download and SHA-256 check commands shown there; no version is pinned here. Extract it into `C:\actions-runner`.
- [ ] 2.9 Register it as a service:
  - Copy the one-time registration token from that page.
  - In an elevated PowerShell, run `.\config.cmd --unattended --url https://github.com/lausellduane/financial-agent-server --token <TOKEN> --name old-pc-local-builder --labels local-builder --work _work --runasservice --windowslogonaccount ".\ghrunner" --windowslogonpassword "<pw>"`.
- [ ] 2.10 Check it's running: `Get-Service "actions.runner.*"` shows Running, and the Runners page shows Idle with labels `self-hosted, Windows, X64, local-builder`.
- [ ] 2.11 Install tools as `ghrunner` (`runas /user:ghrunner powershell`):
  - Git, Node.js LTS (the same major version CI uses), and GitHub CLI, for example with `winget install Git.Git`, `winget install OpenJS.NodeJS.LTS`, `winget install GitHub.cli`.
  - Aider: `python -m pip install aider-install`, then `aider-install`, then open a new shell and run `aider --version`.
- [ ] 2.12 Run Aider locally as `ghrunner` in a temp clone:
  - First, warm up with `Invoke-RestMethod -Method Post http://127.0.0.1:11434/api/generate -Body '{"model":"qwen2.5-coder:7b","prompt":"Reply OK","stream":false,"keep_alive":"30m","options":{"num_ctx":4096}}' -ContentType application/json`.
  - Then run `aider --model ollama_chat/qwen2.5-coder:7b --edit-format whole --map-tokens 0 --no-auto-commits --yes-always --read conventions\CONVENTIONS.md --message "add a one-line comment at the top of README.md" README.md`.
  - Confirm that a diff appears and that `ollama ps` still shows 4096 ctx, meaning the model didn't reload. Then delete the clone.
- [ ] 2.13 In that clone, run `npm ci` and `npm test` once as `ghrunner`. Whether vitest and the Workers pool run on Windows is **unverified**.
- [ ] 2.14 Create a weekly scheduled task that stops the runner service, wipes `C:\actions-runner\_work\*`, and starts the service again.
- [ ] 2.15 Optional (open question Q4): set Windows Update Active hours so restarts happen at a known time.

## 3. Repo files (via PR, after 1.1 and 1.6)
- [ ] 3.1 [PR] Add `.github/workflows/local-builder.yml` per design.md §6. It needs:
  - an `issues: labeled` trigger only, with the owner-only `if:` guard;
  - `permissions: {}` at the top and three write scopes on the job;
  - `persist-credentials: false`;
  - the **pre-flight Ollama check** and the **warm-up** step;
  - the context-budget check;
  - timeouts: job 60, pre-flight 2, warm-up 5, Aider 25 × 2, the rest ≤ 10;
  - forbidden-path and BLOCKED.md guards;
  - PR tracking: label, title prefix, branch name, and stats block;
  - failure commenting and `if: always()` cleanup;
  - `actions/checkout` pinned to a full commit SHA;
  - **no approve calls**.
- [ ] 3.2 [PR] Add `conventions/CONVENTIONS.md` and `prompts/job-prompt.md` from this change's drafts.
- [ ] 3.3 [PR] Add `.aider.conf.yml` with the model, `map-tokens: 0`, `auto-commits: false`, and analytics off. Add `.aider.model.settings.yml` with `num_ctx: 4096` under `extra_params`.
- [ ] 3.4 [Team] Code Reviewer checks that:
  - no other workflow uses `self-hosted`;
  - no `${{ }}` issue text appears inside `run:`;
  - no secrets are referenced;
  - the workflow doesn't approve PRs;
  - issue text never reaches the prompt.
- [ ] 3.5 [Duane] Merge the PR. `issues` triggers only work once the workflow is on `master`.

## 4. Pilot
- [ ] 4.1 [Team] Failure test A: an issue with `openspec-change: does-not-exist`. Expect a comment, `local-builder-failed`, and no PR.
- [ ] 4.2 [Team, with Duane] Failure test B: Duane quits Ollama from the tray, then labels a valid issue. Expect the pre-flight "Ollama isn't reachable" comment, `local-builder-failed`, and no PR. Then restart Ollama.
- [ ] 4.3 [Team] Negative test: a different label triggers nothing.
- [ ] 4.4 [Team] Builder writes and merges (via PR) an approved OpenSpec change for the pilot card, with a `Files:` list and scenarios.
- [ ] 4.5 [Team] Project Manager opens the pilot issue with `openspec-change: <id>`. Duane, or a bot acting as him (see Q1), adds `local-builder`.
- [ ] 4.6 [Team] Check the PR has the `local-builder` label, the `[local-builder]` title, branch `local-builder/issue-N`, and a complete stats block.
- [ ] 4.7 [Duane] Approve the CI runs on the PR.
- [ ] 4.8 [Team] Code Reviewer reviews against the spec scenarios. QA tests every scenario **before** merge.
- [ ] 4.9 [Duane] Merge if QA passes. Deploys still need his separate yes.
- [ ] 4.10 [Team] DevOps writes a pilot report against the success criteria in design.md §8. Project Manager starts the review-performance log from design.md §10.

## 5. Rollback / kill switch (anytime)
- [ ] 5.1 `Stop-Service "actions.runner.*"`.
- [ ] 5.2 Disable the workflow in the Actions tab, or remove the label from open issues.
- [ ] 5.3 In an elevated PowerShell, run `.\config.cmd remove --token <removal token>`. Then delete `C:\actions-runner` and the `ghrunner` user.
