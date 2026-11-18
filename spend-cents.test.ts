import assert from "node:assert/strict";
import { test } from "node:test";
import { categorizeNarrative } from "./categories.ts";
import {
  isBareReturnPrefix,
  isDebitCardReturn,
  isNonSpendingNarrative,
  isReturnNarrative,
  spendCentsFor,
} from "./spend-cents.ts";

test("debit-card returns in a spending category are money-in on any sign", () => {
  assert.equal(spendCentsFor("CHIPOTLE", 3304, false, "dining"), 3304);
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN CHIPOTLE", 1000, false, "dining"),
    -1000,
  );
  assert.equal(spendCentsFor("CHIPOTLE", -3304, true, "dining"), 3304);
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN CHIPOTLE", 1000, true, "dining"),
    -1000,
  );
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN CHIPOTLE", -1000, true, "dining"),
    -1000,
  );
});

test("debit-card returns at uncategorized or Other merchants are money-in", () => {
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN ZOOPLEX GADGETS", 2000, false, "unknown"),
    -2000,
  );
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN ZOOPLEX GADGETS", 2000, true, "unknown"),
    -2000,
  );
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN ZOOPLEX GADGETS", -2000, true, "unknown"),
    -2000,
  );
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN ZOOPLEX GADGETS", 2000, false, "other"),
    -2000,
  );
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN ZOOPLEX GADGETS", 2000, true, "other"),
    -2000,
  );
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN ZOOPLEX GADGETS", -2000, true, "other"),
    -2000,
  );
});

test("income, transfers, and credit-card payments stay excluded", () => {
  assert.equal(
    spendCentsFor("CREDIT CARD PAYMENT", 20000, false, "credit-cards"),
    20000,
  );
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN", 500, false, "credit-cards"),
    500,
  );
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN PAYPAL TRANSFER", 1500, false, "transfers"),
    1500,
  );
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN PAYROLL", 800, false, "income"),
    800,
  );
});

test("a bare RETURN is a refund only on a signed money-in row", () => {
  assert.equal(isDebitCardReturn("DEBIT CARD RETURN CHIPOTLE"), true);
  assert.equal(isDebitCardReturn("RETURN CHIPOTLE 2210 RALEIGH NC"), false);
  assert.equal(isBareReturnPrefix("RETURN CHIPOTLE 2210 RALEIGH NC"), true);
  assert.equal(isBareReturnPrefix("  return chipotle"), true);
  assert.equal(isBareReturnPrefix("RETURNED CHECK FEE"), false);
  assert.equal(isBareReturnPrefix("RETURNS INC RALEIGH"), false);
  assert.equal(isBareReturnPrefix("PURCHASE AT RETURN TO VENDOR LLC"), false);
  // Unsigned: the prefix is ambiguous, so it is not a refund.
  assert.equal(isReturnNarrative("RETURN CHIPOTLE", 1000, false), false);
  assert.equal(spendCentsFor("RETURN CHIPOTLE", 1000, false, "dining"), 1000);
  // Signed money-in: treat as a refund.
  assert.equal(isReturnNarrative("RETURN CHIPOTLE", 1000, true), true);
  assert.equal(spendCentsFor("RETURN CHIPOTLE", 1000, true, "dining"), -1000);
  // Signed charge (negative amount): leave it as spend, including fee names.
  assert.equal(isReturnNarrative("RETURN ITEM FEE", -1200, true), false);
  assert.equal(spendCentsFor("RETURN ITEM FEE", -1200, true, "other"), 1200);
  assert.equal(spendCentsFor("RETURN OF THE MAC CAFE", -1800, true, "dining"), 1800);
  // DEBIT CARD RETURN stays a refund on any sign.
  assert.equal(isReturnNarrative("DEBIT CARD RETURN CHIPOTLE", 1000, false), true);
  assert.equal(isReturnNarrative("DEBIT CARD RETURN CHIPOTLE", -1000, true), true);
  assert.equal(spendCentsFor("RETURNED CHECK FEE", 3500, false, "other"), 3500);
});

test("an unsigned bare RETURN is a refund only when it matches a purchase", () => {
  assert.equal(isReturnNarrative("RETURN CHIPOTLE", 1000, false, true), true);
  assert.equal(spendCentsFor("RETURN CHIPOTLE", 1000, false, "dining", true), -1000);
  assert.equal(spendCentsFor("RETURN CHIPOTLE", 1000, false, "dining", false), 1000);
  // A signed file still decides by sign, whatever the purchase match says.
  assert.equal(isReturnNarrative("RETURN ITEM FEE", -1200, true, true), false);
});

test("income, transfer, card-payment and bank lines are never refunds", () => {
  assert.equal(isNonSpendingNarrative("RETURN DIRECT DEPOSIT ACME PAYROLL"), true);
  assert.equal(isReturnNarrative("RETURN DIRECT DEPOSIT ACME PAYROLL", 200000, true), false);
  assert.equal(isReturnNarrative("DEBIT CARD RETURN PAYROLL CARD", 2500, true), false);
  assert.equal(isReturnNarrative("RETURN ZELLE PAYMENT FROM JANE", 5000, true), false);
  assert.equal(isReturnNarrative("RETURN CHASE CREDIT CRD AUTOPAY", 5000, true), false);
  assert.equal(isReturnNarrative("RETURN STATE EMPLOYEES CREDIT UNION", 5000, true), false);
  // The income rule runs first, so the model never gets to call these Other.
  assert.equal(categorizeNarrative("RETURN DIRECT DEPOSIT ACME PAYROLL", 200000, true), "income");
  assert.equal(categorizeNarrative("RETURN DIRECT DEPOSIT ACME PAYROLL", 200000, false), "income");
  assert.equal(categorizeNarrative("DEBIT CARD RETURN PAYROLL CARD", 2500, true), "income");
  assert.equal(categorizeNarrative("RETURN ZELLE PAYMENT FROM JANE", 5000, true), "transfers");
  // Not a refund, so a stored income/Other label is never flipped to -spend
  // by the return rule (abs on an unsigned file).
  assert.equal(spendCentsFor("DEBIT CARD RETURN PAYROLL CARD", 2500, false, "other"), 2500);
  assert.equal(isNonSpendingNarrative("RETURN CHIPOTLE"), false);
  assert.equal(isNonSpendingNarrative("PLANET HOME LENDING MTG PMT"), false);
});
