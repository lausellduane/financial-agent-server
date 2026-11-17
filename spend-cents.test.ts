import assert from "node:assert/strict";
import { test } from "node:test";
import { spendCentsFor } from "./spend-cents.ts";

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

test("uncategorized and non-spending returns keep the ledger sign", () => {
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN GROK XAI", 15, false, "unknown"),
    15,
  );
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN GROK XAI", 15, true, "unknown"),
    -15,
  );
  assert.equal(
    spendCentsFor("CREDIT CARD PAYMENT", 20000, false, "credit-cards"),
    20000,
  );
  assert.equal(
    spendCentsFor("DEBIT CARD RETURN", 500, false, "credit-cards"),
    500,
  );
});
