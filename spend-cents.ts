import type { Category } from "./categories.js";

/** Unambiguous debit-card return phrase, on any sign or ledger type. */
export function isDebitCardReturn(text: string): boolean {
  return /\bDEBIT\s+CARD\s+RETURN\b/.test(text.toUpperCase());
}

/** Description starts with "RETURN " but not RETURNED or RETURNS. */
export function isBareReturnPrefix(text: string): boolean {
  return /^RETURN\s/.test(text.toUpperCase().trim());
}

// DEBIT CARD RETURN is always a refund. A bare "RETURN " is a refund only
// on a signed file when the amount is money-in (positive). On unsigned
// files that prefix is ambiguous — it may be a fee or a merchant name.
export function isReturnNarrative(
  text: string,
  amountCents: number,
  signedLedger: boolean,
): boolean {
  if (isDebitCardReturn(text)) return true;
  return isBareReturnPrefix(text) && signedLedger && amountCents > 0;
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
// A bare RETURN is money-in only when isReturnNarrative says so.
// Income, transfers, and credit-card payments stay excluded.
export function spendCentsFor(
  narrative: string,
  amountCents: number,
  signedLedger: boolean,
  category: Category | "unknown",
): number {
  if (
    isReturnNarrative(narrative, amountCents, signedLedger) &&
    !isNonSpendingCategory(category)
  ) {
    return -Math.abs(amountCents);
  }
  return signedLedger ? -amountCents : Math.abs(amountCents);
}
