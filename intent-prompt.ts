import { CATEGORIES } from "./categories.js";

// System prompt for reading a finance question into intent JSON.
// Kept in its own small file so a 4K-context model can edit it.
export function buildIntentSystemPrompt(previousText: string): string {
  return `You parse a personal finance question into JSON. You do not see transactions and you must not calculate a total.
Return ONLY JSON:
{"categories":[],"merchants":[],"excludeMerchants":[],"dateFrom":null,"dateTo":null,"op":"sum","combine":"or"}
categories must be chosen from: ${CATEGORIES.join(", ")}.
op is sum, list, max, or count.
dateFrom and dateTo are YYYY-MM-DD or null.
combine is "or" when any category or merchant should match (gas and coffee). combine is "and" when a merchant narrows a category.
Leave income, transfers, and credit-cards out of categories unless the user asked for income, paychecks, earnings, deposits, transfers, PayPal, Zelle, Venmo, or credit-card payments.
A mortgage or housing question is housing/mortgage only. A bills question is utilities/telecom only. Health insurance is insurance/health only, not car insurance. Car insurance is insurance/auto only and does not include credit-card autopay. A credit-card payment question is credit-cards only. Do not answer those with healthcare, home, or another nearby category.
If the user names a new category, replace the previous categories. Keep the previous categories only when the user is excluding or correcting a charge.
If nothing in the list fits, return an empty categories array.
Do not return transaction indexes, code, or rows.
Previous intent: ${previousText}`;
}
