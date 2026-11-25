# Change: Pilot card — "Other money in" guidance in the question-reading prompt

> **Status: DRAFT for Duane's approval.** Prepared Nov 24, 2026. This is the first real card for the local builder
> (add-local-builder-runner design.md §8). Merging this PR approves the card and lands the prep refactor.

## Why

Code Reviewer's leftover LOW from #9: the model that reads a question into intent JSON is offered the `money-in`
category ("Other money in") but gets no guidance about when to use it. Its income line also lists bare "deposits",
while the rule-based reader (`MONEY_IN_PATTERN` in `query-intent.ts`) treats bare deposits as `money-in` and only
"direct deposit" as income. So the two readers can disagree on "how much did I get in deposits?".

## What Changes

1. **Prep, done by Claude in this PR (task 1.1):** move the intent system prompt, word for word, out of
   `query-intent.ts` into a new `intent-prompt.ts` (`buildIntentSystemPrompt(previousText)`). This doesn't change
   behavior.
   - `query-intent.ts` is 29 KB, about 7,300 tokens, far over the local builder's budget of about 2,500 tokens. The
     builder can't edit it.
   - `intent-prompt.ts` is about 2 KB, so the whole job (conventions, job prompt, this `tasks.md`, both files) is
     estimated at about 1,800 tokens.
2. **Local builder (tasks 2.1 and 2.2):**
   - Change "deposits" to "direct deposits" in the income line.
   - Add one fixed sentence of `money-in` guidance.
   - Add a small Vitest spec, `test/intent-prompt.spec.ts`. Vitest picks up `test/**/*.spec.ts` automatically, so
     `package.json` stays untouched.
   - Each task gives the exact text, so a 7B model has nothing to invent.

## How to run it

After this PR and PR #13 are merged to `master`, open an issue (as `lausellduane`) whose body has:

```
openspec-change: pilot-other-money-in-prompt
tasks: 2.1,2.2
```

Then add the `local-builder` label.

## Impact

- **Affected spec:** new capability `question-reading`.
- **Affected code:**
  - `intent-prompt.ts` (new);
  - `query-intent.ts` (now calls `buildIntentSystemPrompt`);
  - after the pilot, `test/intent-prompt.spec.ts`.
- **Behavior:** the model prompt text changes only in the pilot's two edits. The existing test
  `asks the model for intent JSON and not for ledger rows` covers the prep refactor.

## Acceptance criteria (pilot)

- [ ] The local builder opens a PR from `local-builder/issue-<N>` that touches only `intent-prompt.ts` and
      `test/intent-prompt.spec.ts`, with the `local-builder` label, the `[local-builder]` title, and a complete stats block.
- [ ] Both scenarios in `specs/question-reading/spec.md` hold, and `npm test`, `npx tsc --noEmit`, and
      `npm run check:worker` pass in CI.
- [ ] Code Reviewer and QA review it like any other PR, and Duane merges.
