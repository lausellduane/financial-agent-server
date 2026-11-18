import type { Category } from "./categories.js";

function isDebitCardReturn(text: string): boolean {
  return /\bDEBIT\s+CARD\s+RETURN\b/.test(text.toUpperCase());
}

function isNonSpendingCategory(category: Category | "unknown"): boolean {
  return (
    category === "income" ||
    category === "transfers" ||
    category === "credit-cards"
  );
}

// A debit-card return in a spending category, Other, or an uncategorized
// merchant is money-in, even on an unsigned file or a signed-negative amount.
// Income, transfers, and credit-card payments stay excluded.
export function spendCentsFor(
  narrative: string,
  amountCents: number,
  signedLedger: boolean,
  category: Category | "unknown",
): number {
  if (isDebitCardReturn(narrative) && !isNonSpendingCategory(category)) {
    return -Math.abs(amountCents);
  }
  return signedLedger ? -amountCents : Math.abs(amountCents);
}
