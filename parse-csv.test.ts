import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_LEDGER_ROWS } from "./constants.ts";
import { parseCsv } from "./server.ts";

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
