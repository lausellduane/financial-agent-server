import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMonthlySpend,
  displayCategory,
  monthKey,
  monthLabel,
  previousMonthKey,
  type SpendEvent,
} from "./monthly-spend.ts";

function event(
  date: string,
  merchant: string,
  spendCents: number,
  category: string,
): SpendEvent {
  return { date, merchant, spendCents, category };
}

test("month helpers", () => {
  assert.equal(monthKey("2026-11-07"), "2026-11");
  assert.equal(monthKey(""), null);
  assert.equal(monthKey("11/07/2026"), null);
  assert.equal(monthLabel("2026-11"), "Nov 2026");
  assert.equal(monthLabel("2026-01"), "Jan 2026");
  assert.equal(previousMonthKey("2026-11"), "2026-10");
  assert.equal(previousMonthKey("2026-01"), "2025-12");
  assert.equal(displayCategory("dining"), "Eating out");
  assert.equal(displayCategory("unknown"), "Other");
  assert.equal(displayCategory(""), "Other");
});

test("builds a month of net spend and drops income and transfers", () => {
  const months = buildMonthlySpend([
    event("2026-11-02", "Food Lion", 61200, "groceries"),
    event("2026-11-03", "Piedmont", 54000, "utilities/telecom"),
    event("2026-11-04", "Chipotle", 20000, "dining"),
    event("2026-11-05", "Chipotle", -5000, "dining"),
    event("2026-11-06", "Acme Payroll", 90000, "income"),
    event("2026-11-07", "Venmo", 4000, "transfers"),
    event("2026-11-08", "Odd Shop", 41000, "unknown"),
    event("2026-11-09", "Random", 0, "shopping"),
  ]);

  assert.equal(months.length, 1);
  const november = months[0];
  assert.ok(november);
  assert.equal(november.month, "2026-11");
  assert.equal(november.label, "Nov 2026");
  assert.equal(november.totalCents, 61200 + 54000 + 15000 + 41000);
  assert.equal(november.diningCents, 15000);
  assert.deepEqual(
    november.categories.map((row) => row.name),
    ["Groceries", "Utilities", "Eating out", "Other"],
  );
  assert.equal(november.categories[0]?.cents, 61200);
  assert.equal(november.categories.at(-1)?.name, "Other");
  assert.equal(november.categories.at(-1)?.cents, 41000);
  assert.deepEqual(november.topMerchants, [
    { name: "Food Lion", cents: 61200 },
    { name: "Piedmont", cents: 54000 },
    { name: "Odd Shop", cents: 41000 },
    { name: "Chipotle", cents: 15000 },
  ]);
  assert.deepEqual(november.biggestPurchase, { name: "Food Lion", cents: 61200 });
});

test("keeps Other last even when it is the largest bar", () => {
  const months = buildMonthlySpend([
    event("2026-10-01", "Unknown Store", 8000, "other"),
    event("2026-10-02", "Shell", 2000, "gas/auto"),
  ]);
  assert.deepEqual(
    months[0]?.categories.map((row) => row.name),
    ["Gas/auto", "Other"],
  );
});

test("splits months, skips undated rows, and ranks merchants", () => {
  const months = buildMonthlySpend([
    event("2026-10-31", "Shell", 2000, "gas/auto"),
    event("2026-11-01", "Shell", 1000, "gas/auto"),
    event("2026-11-02", "Costco", 5000, "groceries"),
    event("not-a-date", "Lost", 9999, "shopping"),
    event("", "Also Lost", 9999, "shopping"),
  ]);
  assert.deepEqual(
    months.map((row) => row.month),
    ["2026-10", "2026-11"],
  );
  assert.equal(months[0]?.totalCents, 2000);
  assert.equal(months[1]?.totalCents, 6000);
  assert.deepEqual(months[1]?.topMerchants, [
    { name: "Costco", cents: 5000 },
    { name: "Shell", cents: 1000 },
  ]);
  assert.deepEqual(months[1]?.biggestPurchase, { name: "Costco", cents: 5000 });
});

test("a refund-only month can have a negative total and no biggest purchase", () => {
  const months = buildMonthlySpend([
    event("2026-09-04", "Amazon", -1200, "shopping"),
  ]);
  assert.equal(months[0]?.totalCents, -1200);
  assert.equal(months[0]?.biggestPurchase, null);
  assert.deepEqual(months[0]?.categories, [{ name: "Shopping", cents: -1200 }]);
});
