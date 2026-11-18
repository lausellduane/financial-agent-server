import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_LEDGER_ROWS } from "./constants.ts";
import { parseCsv } from "./server.ts";
import {
  bareReturnMatchesPurchase,
  cleanMerchantName,
  purchaseMerchants,
} from "./statement.ts";

const statement = `Bank export
Account number,123
Date,Description,Amount
2026-01-02,DEBIT CARD PURCHASE CHIPOTLE 1234 NC,-12.50
2026-01-04,COSTCO WHSE #123 RALEIGH NC,-86.20
`;

test("parseCsv skips the preamble and keeps the data rows", async () => {
  const rows = await parseCsv(statement);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.Description, "DEBIT CARD PURCHASE CHIPOTLE 1234 NC");
  assert.equal(rows[1]?.Amount, "-86.20");
  assert.ok(rows.length <= MAX_LEDGER_ROWS);
});

test("parseCsv strips a UTF-8 BOM from the header", async () => {
  const rows = await parseCsv(
    "\uFEFFDate,Description,Amount\n2026-01-03,PIEDMONT NATURAL GAS,-40.00\n",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.Description, "PIEDMONT NATURAL GAS");
  assert.equal(Object.keys(rows[0] ?? {})[0], "Date");
});

test("cleanMerchantName strips DEBIT CARD RETURN always, and bare RETURN only when signed money-in", () => {
  const purchase = cleanMerchantName(
    "DEBIT CARD PURCHASE CHIPOTLE 2210 RALEIGH NC",
  );
  const debitReturn = cleanMerchantName(
    "DEBIT CARD RETURN CHIPOTLE 2210 RALEIGH NC",
  );
  const debitReturnUnsigned = cleanMerchantName(
    "DEBIT CARD RETURN CHIPOTLE 2210 RALEIGH NC",
    1000,
    false,
  );
  assert.equal(purchase, "CHIPOTLE");
  assert.equal(debitReturn, "CHIPOTLE");
  assert.equal(debitReturnUnsigned, "CHIPOTLE");
  // Unsigned or missing sign: keep the bare RETURN prefix.
  assert.equal(
    cleanMerchantName("RETURN CHIPOTLE 2210 RALEIGH NC"),
    "RETURN CHIPOTLE",
  );
  assert.equal(
    cleanMerchantName("RETURN CHIPOTLE 2210 RALEIGH NC", 1000, false),
    "RETURN CHIPOTLE",
  );
  // Signed money-in: strip so it merges with the purchase.
  assert.equal(
    cleanMerchantName("RETURN CHIPOTLE 2210 RALEIGH NC", 1000, true),
    "CHIPOTLE",
  );
  // Signed charges that just start with RETURN keep their names.
  assert.equal(cleanMerchantName("RETURN ITEM FEE", -1200, true), "RETURN ITEM FEE");
  assert.equal(
    cleanMerchantName("RETURN OF THE MAC CAFE", -1800, true),
    "RETURN OF THE MAC CAFE",
  );
});

test("cleanMerchantName does not strip RETURNED or RETURNS as a bare RETURN", () => {
  assert.equal(cleanMerchantName("RETURNED CHECK FEE"), "RETURNED CHECK FEE");
  assert.equal(cleanMerchantName("RETURNS INC RALEIGH NC"), "RETURNS INC RALEIGH");
});

test("cleanMerchantName: an unsigned bare RETURN merges only with a matching purchase", () => {
  assert.equal(
    cleanMerchantName("RETURN CHIPOTLE 2210 RALEIGH NC", 1000, false, true),
    "CHIPOTLE",
  );
  assert.equal(cleanMerchantName("RETURN COSTCO WHSE #123", 2000, false, true), "Costco");
  // Sign-aware RETURN handling runs before brand aliases.
  assert.equal(cleanMerchantName("RETURN COSTCO WHSE #123", 2000, false), "RETURN COSTCO WHSE");
  assert.equal(cleanMerchantName("RETURN TARGET T-1234", 1500, false), "RETURN TARGET T-1234");
  assert.equal(cleanMerchantName("RETURN COSTCO WHSE #123", -2000, true), "RETURN COSTCO WHSE");
  assert.equal(cleanMerchantName("RETURN COSTCO WHSE #123", 2000, true), "Costco");
  assert.equal(cleanMerchantName("DEBIT CARD RETURN TARGET T-1234", 1500, false), "Target");
});

test("cleanMerchantName keeps RETURN on income lines so the income list is distinguishable", () => {
  assert.equal(
    cleanMerchantName("RETURN DIRECT DEPOSIT ACME PAYROLL", 200000, true),
    "RETURN DIRECT DEPOSIT ACME PAYROLL",
  );
  assert.equal(
    cleanMerchantName("DEBIT CARD RETURN PAYROLL CARD", 2500, true),
    "DEBIT CARD RETURN PAYROLL CARD",
  );
});

test("purchase matching uses cleaned merchants and skips returns and deposits", () => {
  const purchases = purchaseMerchants([
    { narrative: "DEBIT CARD PURCHASE CHIPOTLE 2210 RALEIGH NC", amountCents: 3304, signedLedger: false },
    { narrative: "COSTCO WHSE #123", amountCents: 8620, signedLedger: false },
    { narrative: "RETURN ITEM FEE", amountCents: 1200, signedLedger: false },
    { narrative: "DIRECT DEPOSIT ACME PAYROLL", amountCents: 200000, signedLedger: false },
    { narrative: "TARGET T-1234", amountCents: 5000, signedLedger: true },
  ]);
  assert.equal(bareReturnMatchesPurchase("RETURN CHIPOTLE 2210 RALEIGH NC", false, purchases), true);
  assert.equal(bareReturnMatchesPurchase("RETURN COSTCO WHSE #999", false, purchases), true);
  assert.equal(bareReturnMatchesPurchase("RETURN ITEM FEE", false, purchases), false);
  assert.equal(bareReturnMatchesPurchase("RETURN OF THE MAC CAFE", false, purchases), false);
  assert.equal(bareReturnMatchesPurchase("RETURN DIRECT DEPOSIT ACME PAYROLL", false, purchases), false);
  // A signed money-in TARGET row is not a purchase.
  assert.equal(bareReturnMatchesPurchase("RETURN TARGET T-1234", false, purchases), false);
  // Signed files never use purchase matching.
  assert.equal(bareReturnMatchesPurchase("RETURN CHIPOTLE", true, purchases), false);
  assert.equal(bareReturnMatchesPurchase("RETURNS INC STORE", false, purchases), false);
});
