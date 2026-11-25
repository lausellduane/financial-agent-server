# question-reading

## ADDED Requirements

### Requirement: Model guidance for Other money in
The intent system prompt (`buildIntentSystemPrompt` in `intent-prompt.ts`) SHALL tell the model when to choose the `money-in` category, matching the rule-based reading in `query-intent.ts` (`MONEY_IN_PATTERN`): other money in, money coming in, tax refunds, and deposits that are not paychecks. It MUST say that a direct deposit or paycheck is income, not `money-in`, and its income line MUST say "direct deposits" rather than bare "deposits".

#### Scenario: Other money in has guidance
- **WHEN** `buildIntentSystemPrompt("null")` is called
- **THEN** the prompt contains `Use money-in only when` and names other money in, money coming in, tax refunds, and deposits that are not paychecks

#### Scenario: Direct deposit stays income
- **WHEN** `buildIntentSystemPrompt("null")` is called
- **THEN** the prompt contains `A direct deposit or paycheck is income, not money-in.` and its income line lists `direct deposits`, not bare `deposits`
