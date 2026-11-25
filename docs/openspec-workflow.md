# OpenSpec workflow with Claude

This is how a change goes from an idea to merged code in this repo. Project Manager orchestrates. Claude explores, proposes, and applies. You (Duane) approve at each gate. Nothing is merged, and nothing is pushed to `master`, without your yes.

The slash commands below (`/opsx:explore`, `/opsx:propose`, `/opsx:apply`, `/opsx:archive`) are OpenSpec chat commands. If they are not installed in Claude's environment, Claude follows the same steps described here.

## What you do at each step

1. Open a Claude **Explore** issue describing the idea.
2. Answer Project Manager's questions, one at a time, until every open question is settled.
3. Review the proposal PR (change folder only). Merge it when you are happy with it. That merge is the green light for apply.
4. Claude starts apply on its own after that merge. You do not need to write an `@claude` comment.
5. After Code Reviewer and QA sign off, merge the code PR.
6. Archive should already be in that code PR. If it is not, merge a short follow-up.

To fix a pull request that is already open (for example [server PR #13](https://github.com/lausellduane/financial-agent-server/pull/13)), skip the issue form and comment `@claude` on that PR instead. See [Existing-PR fixes](#existing-pr-fixes).

## 1. Explore

Open the [Claude OpenSpec task form](https://github.com/lausellduane/financial-agent-server/issues/new/choose) and set **Stage** to **Explore**. Describe the idea in the title and notes. The change folder can be left blank. The form already includes the `@claude` request, so submitting it starts Claude.

Claude runs `/opsx:explore` (or the equivalent). It must not create a change folder, commit, branch, or pull request. It posts its findings and a numbered list of open questions or decisions as a comment on the issue, then stops.

## 2. Interview

Project Manager takes that numbered list and asks you the questions in chat, one at a time, until every item is answered or explicitly deferred.

Project Manager then posts your answers as a single issue comment. That comment has to come from your GitHub account (`lausellduane`), or from a bot acting as you with your yes, so it is a trusted brief. Project Manager will not post it without your approval of the text.

## 3. Propose

Once the answers are on the issue, Claude runs `/opsx:propose` (or the equivalent) and opens a pull request that adds only `openspec/changes/<change-id>/` (typically `proposal.md`, `design.md`, `tasks.md`, and `specs/`). No application code, and no direct push to `master`.

Code Reviewer checks the proposal for gaps. You approve it or request edits. **You merging that PR is the green light for apply.** You do not need a separate comment.

## 4. Auto-apply starts after the proposal merges

When a pull request that adds or updates `openspec/changes/<change-id>/` is merged to `master`, [openspec-auto-apply.yml](../.github/workflows/openspec-auto-apply.yml) opens an **Apply** issue for that change and starts Claude in automation mode.

It is built to be safe:

- It only runs on a push to `master`.
- It only continues if you pushed, or if you authored or merged the associated pull request.
- It skips `openspec/changes/archive/` and archive moves (a folder leaving `changes/` and landing under `changes/archive/`).
- It is idempotent: if an open Apply issue already exists for that change id, it does not open a second one and does not start a second Claude run. To retry, run the **Claude Code** workflow by hand (`workflow_dispatch`) with the issue number and change folder. Anyone with write access to the repository can start that dispatch.

An issue opened by `github-actions[bot]` would not start Claude through an `@claude` mention, because the action rejects bot actors by default. Auto-apply therefore calls `claude.yml` through `workflow_call` (automation mode) instead of relying on a mention. A mention from anyone with write access is enough to start Claude; there is no extra `lausellduane` actor gate.

## 5. Apply, review, and test

Claude runs `/opsx:apply` (or follows `tasks.md` in order), works on a branch, and opens a code pull request against `master`. It must not merge, approve, force-push, or push to `master`.

Code Reviewer reviews the code. QA tests it against the change's acceptance criteria. You merge it when you are ready.

## 6. Archive

Claude should move the change to `openspec/changes/archive/` and update `openspec/specs/` in the same code PR, so accepted specs match what is going live. If archive cannot go in that PR, Claude opens a short follow-up PR after the code merges. Project Manager will nudge if archive is forgotten.

## Existing-PR fixes

When a fix has to land on a branch that is already open (a good example is QA findings on PR #13), do not open a new Explore or Apply issue for the fix. A new issue would branch from `master` and miss the open PR's code.

Instead:

1. Put the approved OpenSpec change folder on `master` first (a small PR that adds only that folder).
2. Comment `@claude` on the existing PR. Anyone with write access to the repository can start Claude; the action's built-in write-access check still applies.
3. Claude works on that PR's branch.

The issue form and the auto-apply workflow are the default path for new work. This comment path is the exception for fixes that belong on an already-open PR.

## Related files

- [CLAUDE.md](../CLAUDE.md) — standing rules for Claude (PR-only, approved changes, tests).
- [openspec/README.md](../openspec/README.md) — layout of `changes/` and `specs/`.
- [Claude OpenSpec task form](../.github/ISSUE_TEMPLATE/claude-openspec-task.yml) — Explore and Apply issue form.
- [claude.yml](../.github/workflows/claude.yml) — `@claude` mentions, plus the `workflow_call` / `workflow_dispatch` entry point used by auto-apply.
- [openspec-auto-apply.yml](../.github/workflows/openspec-auto-apply.yml) — opens the Apply issue and starts Claude after a change folder merges.
