import assert from "node:assert/strict";
import { test } from "node:test";
import { isDebitCardReturn, spendCentsFor } from "./spend-cents.ts";

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

test("a bare RETURN prefix is a return; RETURNED and RETURNS are not", () => {
  assert.equal(isDebitCardReturn("RETURN CHIPOTLE 2210 RALEIGH NC"), true);
  assert.equal(isDebitCardReturn("  return chipotle"), true);
  assert.equal(isDebitCardReturn("DEBIT CARD RETURN CHIPOTLE"), true);
  assert.equal(isDebitCardReturn("RETURNED CHECK FEE"), false);
  assert.equal(isDebitCardReturn("RETURNS INC RALEIGH"), false);
  assert.equal(isDebitCardReturn("PURCHASE AT RETURN TO VENDOR LLC"), false);
  assert.equal(spendCentsFor("RETURN CHIPOTLE", 1000, false, "dining"), -1000);
  assert.equal(spendCentsFor("RETURN CHIPOTLE", 1000, true, "dining"), -1000);
  assert.equal(spendCentsFor("RETURN CHIPOTLE", -1000, true, "dining"), -1000);
  assert.equal(spendCentsFor("RETURNED CHECK FEE", 1000, false, "other"), 1000);
});
