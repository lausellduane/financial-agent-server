import {
  isBareReturnPrefix,
  isDebitCardReturn,
  isNonSpendingNarrative,
  isReturnNarrative,
  type Category,
} from "./categories.js";

export { isBareReturnPrefix, isDebitCardReturn, isNonSpendingNarrative, isReturnNarrative };


function isNonSpendingCategory(category: Category | "unknown"): boolean {
  return (
    category === "income" ||
    category === "transfers" ||
    category === "credit-cards"
  );
}

// A debit-card return in a spending category, Other, or an uncategorized
// merchant is money-in, even on an unsigned file or a signed-negative amount.
// A bare RETURN is money-in only when isReturnNarrative says so (signed
// money-in, or unsigned with a matching purchase merchant).
// Income, transfers, and credit-card payments stay excluded.
export function spendCentsFor(
  narrative: string,
  amountCents: number,
  signedLedger: boolean,
  category: Category | "unknown",
  purchaseMatch = false,
): number {
  if (
    isReturnNarrative(narrative, amountCents, signedLedger, purchaseMatch) &&
    !isNonSpendingCategory(category)
  ) {
    return -Math.abs(amountCents);
  }
  return signedLedger ? -amountCents : Math.abs(amountCents);
}
