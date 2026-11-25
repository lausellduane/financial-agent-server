# Tasks: pilot-other-money-in-prompt

## 1. Prep (done by Claude in this PR)
- [x] 1.1 Move the intent system prompt into `intent-prompt.ts`. No text change.

## 2. Local builder
- [ ] 2.1 In `intent-prompt.ts`, change `earnings, deposits, transfers` to `earnings, direct deposits, transfers`. Then add this line right after that line, exactly:
  `Use money-in only when the user asks about other money in, money coming in, tax refunds, or deposits that are not paychecks. A direct deposit or paycheck is income, not money-in.`
  Files:
  - intent-prompt.ts
  Scenarios:
  - Other money in has guidance
  - Direct deposit stays income
- [ ] 2.2 Create `test/intent-prompt.spec.ts`: a Vitest test that calls `buildIntentSystemPrompt("null")` (import from `../intent-prompt`) and expects it to contain `Use money-in only when` and `A direct deposit or paycheck is income, not money-in.`
  Files:
  - test/intent-prompt.spec.ts
  Scenarios:
  - Other money in has guidance
