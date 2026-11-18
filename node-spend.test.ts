import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { setCompleteChatForTests, type ChatTurn } from "./llm.ts";
import { app, resetMemoryLedgerForTests } from "./server.ts";

let base = "";
let server: http.Server;

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

// The Node ledger is process-wide and uploads append, so each test starts empty.
beforeEach(() => {
  resetMemoryLedgerForTests();
});

after(async () => {
  setCompleteChatForTests(null);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function upload(csv: string): Promise<{ status: number; body: { uncategorized?: number } }> {
  const form = new FormData();
  form.set("file", new File([csv], "statement.csv", { type: "text/csv" }));
  const response = await fetch(`${base}/api/upload`, { method: "POST", body: form });
  return {
    status: response.status,
    body: (await response.json()) as { uncategorized?: number },
  };
}

async function ask(question: string): Promise<string> {
  const result = await askRaw(question);
  assert.equal(result.status, 200);
  return result.body.answer ?? "";
}

async function askRaw(question: string): Promise<{
  status: number;
  body: { answer?: string; error?: string };
}> {
  const response = await fetch(`${base}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { answer?: string; error?: string },
  };
}

function csv(rows: string[]): string {
  return ["Date,Description,Amount", ...rows].join("\n");
}

test("node mode nets refunds and ignores deposits for the highest charge", async () => {
  const uploaded = await upload(
    csv([
      "2026-01-02,AMAZON.COM,-20.00",
      "2026-01-03,AMAZON.COM,5.00",
      "2026-01-04,DIRECT DEPOSIT ACME PAYROLL,900.00",
      "2026-01-05,COSTCO,-30.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  const shopping = await ask("shopping");
  assert.match(shopping, /-\$5\.00/);
  assert.match(shopping, /Total: \$15\.00/);
  assert.doesNotMatch(shopping, /900\.00/);
  const highest = await ask("What was my highest charge?");
  assert.match(highest, /Costco/);
  assert.match(highest, /30\.00/);
  assert.doesNotMatch(highest, /900\.00/);
});

test("node mode retries a merchant that failed categorization", async () => {
  let fail = true;
  setCompleteChatForTests(async (messages: ChatTurn[]) => {
    const blob = messages.map((message) => message.content).join("\n");
    if (!blob.includes("ZOOPLEX")) {
      return JSON.stringify({
        categories: [],
        merchants: [],
        excludeMerchants: [],
        dateFrom: null,
        dateTo: null,
        op: "sum",
      });
    }
    if (fail) throw new Error("rate limit");
    return JSON.stringify({
      items: [{ merchant: "ZOOPLEX SNACKBAR", category: "dining" }],
    });
  });
  const uploaded = await upload(
    csv(["2026-01-02,ZOOPLEX SNACKBAR,-9.50", "2026-01-03,CHIPOTLE,-4.00"]),
  );
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.uncategorized, 1);
  const missed = await ask("How much I spent eating out?");
  assert.match(missed, /CHIPOTLE: \$4\.00/);
  assert.doesNotMatch(missed, /ZOOPLEX/);
  assert.match(missed, /1 uncategorized charge \(\$9\.50\)/);
  fail = false;
  const found = await ask("How much I spent eating out?");
  assert.match(found, /ZOOPLEX/);
  assert.match(found, /Total: \$13\.50/);
  setCompleteChatForTests(null);
});

test("node mode drops question context when another statement is appended", async () => {
  const prompts: string[] = [];
  setCompleteChatForTests(async (messages: ChatTurn[]) => {
    prompts.push(messages.map((message) => message.content).join("\n"));
    return JSON.stringify({
      categories: ["gas/auto"],
      merchants: [],
      excludeMerchants: [],
      dateFrom: null,
      dateTo: null,
      op: "sum",
      combine: "or",
    });
  });
  assert.equal(
    (await upload(csv(["2026-01-02,CHIPOTLE,-10.00", "2026-01-03,STARBUCKS,-4.00"])))
      .status,
    200,
  );
  const eating = await ask("How much I spent eating out?");
  assert.match(eating, /CHIPOTLE/);
  assert.equal(
    (await upload(csv(["2026-02-01,SHELL OIL,-40.00", "2026-02-02,STARBUCKS,-4.00"])))
      .status,
    200,
  );
  const follow = await ask("and the other one?");
  assert.ok(prompts.length > 0);
  assert.match(prompts[prompts.length - 1] ?? "", /Previous intent: null/);
  assert.match(follow, /SHELL/);
  assert.match(follow, /Total: \$40\.00/);
  assert.doesNotMatch(follow, /STARBUCKS|CHIPOTLE/);
  setCompleteChatForTests(null);
});

test("node mode keeps a mobile deposit out of gas and highest charge", async () => {
  assert.equal(
    (
      await upload(
        csv([
          "2026-01-02,SHELL OIL,-40.00",
          "2026-01-03,MOBILE DEPOSIT,2500.00",
          "2026-01-04,CHIPOTLE,-10.00",
        ]),
      )
    ).status,
    200,
  );
  const gas = await ask("gas");
  assert.match(gas, /Total: \$40\.00/);
  assert.doesNotMatch(gas, /2500|2460|CHIPOTLE/);

  // An unsigned export is a separate scenario, not part of the signed ledger.
  resetMemoryLedgerForTests();
  assert.equal(
    (await upload(csv(["2026-01-02,COSTCO,30.00", "2026-01-03,MOBILE DEPOSIT,2500.00"])))
      .status,
    200,
  );
  const highest = await ask("What was my highest charge?");
  assert.match(highest, /Costco/);
  assert.match(highest, /30\.00/);
  assert.doesNotMatch(highest, /2500/);
});

test("node mode keeps nonzero blank rows and names the zero-amount row", async () => {
  const uploaded = await upload(
    csv([
      "2026-01-01,CHIPOTLE,-10.00",
      "2026-01-02,pending,-50.00",
      "2026-01-03,,-25.00",
      "2026-01-04,CHIPOTLE,0",
    ]),
  );
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.uncategorized, 0);
  assert.equal((uploaded.body as { count?: number }).count, 4);
  const answer = await ask("How much did I spend?");
  assert.match(answer, /10\.00/);
  assert.match(answer, /50\.00/);
  assert.match(answer, /25\.00/);
  assert.match(answer, /Total: \$85\.00/);
  assert.match(answer, /1 zero-amount row/);
});

test("node mode returns 409 when a held model call outlives a replacement", async () => {
  assert.equal(
    (await upload(csv(["2026-01-02,AMAZON.COM,-20.00"]))).status,
    200,
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  setCompleteChatForTests(async () => {
    markEntered();
    await gate;
    return JSON.stringify({
      categories: ["shopping"],
      merchants: [],
      excludeMerchants: [],
      dateFrom: null,
      dateTo: null,
      op: "sum",
      combine: "or",
    });
  });
  const pending = fetch(`${base}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "How much did I spend on hobbies?" }),
  });
  await entered;
  assert.equal((await upload(csv(["2026-02-01,SHELL OIL,-40.00"]))).status, 200);
  release();
  const response = await pending;
  const body = (await response.json()) as { answer?: string; error?: string };
  assert.equal(response.status, 409);
  assert.match(body.error ?? "", /Ask again/);
  assert.doesNotMatch(JSON.stringify(body), /20\.00/);
  setCompleteChatForTests(null);
});

test("node mode returns 409 when categorization finishes on a replaced statement", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("rate limit");
  });
  assert.equal(
    (await upload(csv(["2026-01-02,ZOOPLEX SNACKBAR,-9.50"]))).status,
    200,
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  setCompleteChatForTests(async () => {
    markEntered();
    await gate;
    return JSON.stringify({
      items: [{ merchant: "ZOOPLEX SNACKBAR", category: "dining" }],
    });
  });
  const pending = fetch(`${base}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "How much did I spend?" }),
  });
  await entered;
  assert.equal((await upload(csv(["2026-02-01,SHELL OIL,-40.00"]))).status, 200);
  release();
  const response = await pending;
  const body = (await response.json()) as { error?: string };
  assert.equal(response.status, 409);
  assert.match(body.error ?? "", /Ask again/);
  assert.doesNotMatch(JSON.stringify(body), /9\.50/);
  setCompleteChatForTests(null);
});

test("node mode does not treat a credit-union credit as fuel", async () => {
  for (const description of [
    "SHELL FEDERAL CREDIT UNION DEPOSIT",
    "SHELL FEDERAL CREDIT UNION",
  ]) {
    resetMemoryLedgerForTests();
    assert.equal(
      (
        await upload(
          csv([
            "2026-01-02,SHELL OIL,-40.00",
            `2026-01-03,${description},2500.00`,
            "2026-01-04,CHIPOTLE,-10.00",
          ]),
        )
      ).status,
      200,
    );
    const gas = await ask("gas");
    assert.match(gas, /Total: \$40\.00/);
    assert.doesNotMatch(gas, /2460|2500|CHIPOTLE/);
    const spent = await ask("How much did I spend?");
    assert.match(spent, /Total: \$50\.00/);
    assert.doesNotMatch(spent, /2450|2500/);
    const highest = await ask("What was my highest charge?");
    assert.match(highest, /40\.00/);
    assert.doesNotMatch(highest, /2500/);
  }
});

test("node mode keeps utility gas and gasoline distinct from groceries", async () => {
  assert.equal(
    (
      await upload(
        csv([
          "2026-01-02,CITY GAS BILL,-80.00",
          "2026-01-03,SHELL OIL,-40.00",
          "2026-01-04,CHIPOTLE,-10.00",
        ]),
      )
    ).status,
    200,
  );
  const narrowGas = await ask("gas");
  assert.match(narrowGas, /Total: \$40\.00/);
  assert.doesNotMatch(narrowGas, /80\.00/);
  assert.match(await ask("How much did I spend?"), /Total: \$130\.00/);
  assert.match(await ask("What was my highest charge?"), /80\.00/);

  assert.equal(
    (
      await upload(
        csv([
          "2026-01-02,CITY GAS BILL,-80.00",
          "2026-01-03,SHELL OIL,-40.00",
          "2026-01-04,CHIPOTLE,-10.00",
          "2026-01-05,COSTCO GASOLINE,-25.00",
          "2026-01-06,COSTCO WHSE,-15.00",
        ]),
      )
    ).status,
    200,
  );
  const gas = await ask("gas");
  assert.match(gas, /40\.00/);
  assert.match(gas, /25\.00/);
  assert.match(gas, /Total: \$65\.00/);
  assert.doesNotMatch(gas, /80\.00|15\.00/);
  const groceries = await ask("groceries");
  assert.match(groceries, /15\.00/);
  assert.doesNotMatch(groceries, /25\.00|80\.00/);
  const spent = await ask("How much did I spend?");
  assert.match(spent, /Total: \$170\.00/);
  const highest = await ask("What was my highest charge?");
  assert.match(highest, /80\.00/);
});

test("node mode keeps Chipotle in a pending merchant name", async () => {
  assert.equal(
    (
      await upload(
        csv([
          "2026-01-01,CHIPOTLE PENDING,-12.00",
          "2026-01-02,pending,-50.00",
          "2026-01-03,CHIPOTLE,0",
        ]),
      )
    ).status,
    200,
  );
  const spent = await ask("How much did I spend?");
  assert.match(spent, /CHIPOTLE PENDING/);
  assert.match(spent, /Pending/);
  assert.match(spent, /Total: \$62\.00/);
  assert.match(spent, /1 zero-amount row/);
});

test("node mode rejects an explicit ISO date that is not a real day", async () => {
  assert.equal(
    (
      await upload(
        csv([
          "2026-01-15,CHIPOTLE,-100.00",
          "2026-02-10,CHIPOTLE,-7.11",
          "2026-03-01,CHIPOTLE,-1.00",
          "2026-03-04,CHIPOTLE,-5.35",
          "2024-02-29,CHIPOTLE,-3.00",
        ]),
      )
    ).status,
    200,
  );
  let modelCalls = 0;
  setCompleteChatForTests(async () => {
    modelCalls += 1;
    throw new Error("model must not repair an invalid date");
  });
  for (const question of [
    "eating out on 2026-02-31",
    "eating out from 2026-02-31 to 2026-03-04",
    "eating out from 2026-03-01 to 2026-02-31",
    "eating out from 2026-02-31 to 2026-13-01",
    "eating out on 2025-02-29",
    "eating out on 2026-13-01",
  ]) {
    const result = await askRaw(question);
    assert.equal(result.status, 400, question);
    assert.match(result.body.error ?? "", /not a valid calendar date/);
    assert.equal(result.body.answer, undefined);
  }
  const reversed = await askRaw("eating out from 2026-03-04 to 2026-03-01");
  assert.equal(reversed.status, 400);
  assert.match(reversed.body.error ?? "", /start date is after the end date/);
  assert.equal(modelCalls, 0);
  setCompleteChatForTests(null);

  const exact = await ask("eating out on 2026-03-04");
  assert.match(exact, /Total: \$5\.35/);
  assert.doesNotMatch(exact, /100\.00/);
  const range = await ask("eating out from 2026-03-01 to 2026-03-04");
  assert.match(range, /Total: \$6\.35/);
  assert.doesNotMatch(range, /100\.00/);
  const leap = await ask("eating out on 2024-02-29");
  assert.match(leap, /Total: \$3\.00/);
  assert.doesNotMatch(leap, /100\.00/);
  const open = await ask("eating out");
  assert.match(open, /100\.00/);
  assert.match(open, /5\.35/);
});

test("node mode rejects an invalid date before categorizing an unknown merchant", async () => {
  let calls = 0;
  setCompleteChatForTests(async () => {
    calls += 1;
    throw new Error("upload categorization fails");
  });
  const uploaded = await upload(
    csv(["2026-01-15,CHIPOTLE,-10.00", "2026-03-04,ZOOPLEX SNACKBAR,-5.35"]),
  );
  assert.equal(uploaded.status, 200);
  assert.ok(calls > 0);
  calls = 0;
  setCompleteChatForTests(async () => {
    calls += 1;
    return JSON.stringify({
      items: [{ merchant: "ZOOPLEX SNACKBAR", category: "dining" }],
    });
  });
  for (const question of [
    "eating out on 2026-02-31",
    "eating out from 2026-02-31 to 2026-03-04",
    "eating out on 2025-02-29",
  ]) {
    const result = await askRaw(question);
    assert.equal(result.status, 400, question);
    assert.match(result.body.error ?? "", /not a valid calendar date/);
    assert.equal(result.body.answer, undefined);
  }
  const reversed = await askRaw("eating out from 2026-03-04 to 2026-03-01");
  assert.equal(reversed.status, 400);
  assert.match(reversed.body.error ?? "", /start date is after the end date/);
  assert.equal(calls, 0);

  const exact = await ask("eating out on 2026-03-04");
  assert.equal(calls, 1);
  assert.match(exact, /ZOOPLEX/);
  assert.match(exact, /Total: \$5\.35/);
  assert.doesNotMatch(exact, /10\.00/);
  setCompleteChatForTests(null);
});

test("node mode separates dining, bills, subscriptions, and the mortgage payment", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("rules cover these merchants");
  });
  const uploaded = await upload(
    csv([
      "2026-10-02,CHIPOTLE,-10.00",
      "2026-10-03,SQ *SHAKE SHACK RALEIGH,-8.00",
      "2026-10-04,DOLLAR TREE GARNER,-4.00",
      "2026-10-05,DOA FAIR ETIX TICKETS RALEIGH,-26.20",
      "2026-10-06,SQ *THE CUB HOUSE PLAY GOSQ.COM,-23.99",
      "2026-10-07,LOWE'S,-17.06",
      "2026-10-08,LOWES #00677* GARNER,-38.00",
      "2026-10-09,PEAK SEASONS HVAC PEAKSEASONSHV NC100126,-17.16",
      "2026-10-10,DUKE ENERGY,-227.32",
      "2026-10-11,ATT PAYMENT,-100.67",
      "2026-10-12,PIEDMONT NATURAL GAS,-49.86",
      "2026-10-13,JOHNSTON COUNTY PUBLIC,-62.40",
      "2026-10-14,CITY GAS BILL,-80.00",
      "2026-10-15,MR COOPER MORTGAGE PMT,-1510.00",
      "2026-10-16,PLANET HOME,-1541.42",
      "2026-10-17,SHELL OIL,-40.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.uncategorized, 0);

  const eating = await ask("How much did I spent eating out?");
  assert.match(eating, /CHIPOTLE/);
  assert.match(eating, /SHAKE SHACK/);
  assert.match(eating, /Total: \$18\.00/);
  assert.doesNotMatch(eating, /DOLLAR TREE|ETIX|CUB HOUSE/);

  const shopping = await ask("shopping");
  assert.match(shopping, /DOLLAR TREE/);
  assert.match(shopping, /Total: \$4\.00/);
  const tickets = await ask("How much did I spend on tickets?");
  assert.match(tickets, /ETIX/);
  assert.match(tickets, /Total: \$26\.20/);
  const subs = await ask("subscriptions");
  assert.match(subs, /CUB HOUSE/);
  assert.match(subs, /PEAK SEASONS/);
  assert.match(subs, /Total: \$41\.15/);
  assert.doesNotMatch(subs, /LOWE|SHAKE SHACK/);

  const bills = await ask("How much did I spent in bills?");
  assert.match(bills, /Duke Energy/);
  assert.match(bills, /ATT/);
  assert.match(bills, /Piedmont/);
  assert.match(bills, /JOHNSTON/);
  assert.match(bills, /Total: \$520\.25/);
  assert.doesNotMatch(bills, /LOWE|PEAK SEASONS|17\.06|38\.00|17\.16|SHELL OIL|Planet Home|1541/i);

  const mortgage = await ask("How much did I spent in mortgage?");
  assert.match(mortgage, /MR COOPER/);
  assert.match(mortgage, /Planet Home/i);
  assert.match(mortgage, /Total: \$3051\.42/);
  assert.doesNotMatch(mortgage, /LOWE|PEAK SEASONS|72\.22/);

  // Each statement below is its own scenario. Uploads append, so start empty.
  resetMemoryLedgerForTests();
  const streamed = await upload(
    csv([
      "2026-10-01,PEACOCK TV LLC,-13.93",
      "2026-10-02,NETFLIX.COM NETFLIX.COM,-21.44",
      "2026-10-03,RING SOLO PLAN RING.COM,-4.99",
      "2026-10-04,GOOGLE*G1SK003M 650-2530000,-9.99",
      "2026-10-05,DISNEYPLUS HULU BUNDLE,-15.99",
      "2026-10-06,CLOUDFLARE,-20.00",
      "2026-10-07,MICROSOFT*XBOX GAME PASS,-16.99",
      "2026-10-08,X CORP,-8.00",
      "2026-10-09,SQ *THE CUB HOUSE PLAY GOSQ.COM,-23.99",
      "2026-10-10,PEAK SEASONS HVAC PEAKSEASONSHV NC100126,-17.16",
      "2026-10-11,MICROSOFT STORE,-50.00",
      "2026-10-12,GOOGLE *PIXEL 8,-199.00",
      "2026-10-13,CHIPOTLE,-10.00",
    ]),
  );
  assert.equal(streamed.status, 200);
  assert.equal(streamed.body.uncategorized, 0);
  const streamedSubs = await ask("How much did I spent in subscriptions?");
  for (const name of [
    "PEACOCK",
    "NETFLIX",
    "RING",
    "GOOGLE*G1SK003M",
    "DISNEYPLUS",
    "CLOUDFLARE",
    "XBOX",
    "X CORP",
    "CUB HOUSE",
    "PEAK SEASONS",
  ]) {
    assert.match(streamedSubs, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(streamedSubs, /Total: \$152\.48/);
  assert.doesNotMatch(streamedSubs, /MICROSOFT STORE|PIXEL|CHIPOTLE/);
  const retail = await ask("shopping");
  assert.match(retail, /MICROSOFT STORE/);
  assert.match(retail, /PIXEL/);
  assert.doesNotMatch(retail, /NETFLIX|XBOX/);

  // Each statement below is its own scenario. Uploads append, so start empty.
  resetMemoryLedgerForTests();
  const insured = await upload(
    csv([
      "2026-10-01,CARY OBGYN 919-4675941,-50.00",
      "2026-10-02,WALGREENS,-7.65",
      "2026-10-03,WALGREENS STORE,-7.71",
      "2026-10-04,WALGREENS STORE,-2.03",
      "2026-10-05,BLUE CROSS BLUE SHIELD,-438.44",
      "2026-10-06,LOWE'S,-17.06",
      "2026-10-07,LOWES #00677* GARNER,-38.00",
      "2026-10-08,PEAK SEASONS HVAC PEAKSEASONSHV NC100126,-17.16",
    ]),
  );
  assert.equal(insured.status, 200);
  assert.equal(insured.body.uncategorized, 0);
  const insurance = await ask("How much did I spent in insurance?");
  assert.match(insurance, /Blue Cross Blue Shield/);
  assert.match(insurance, /Total: \$438\.44/);
  assert.doesNotMatch(insurance, /OBGYN|WALGREENS|LOWE|PEAK SEASONS/);
  const medical = await ask("How much did I spend on medical?");
  assert.match(medical, /OBGYN/);
  assert.match(medical, /WALGREENS/);
  assert.match(medical, /Total: \$67\.39/);
  assert.doesNotMatch(medical, /Blue Cross|LOWE/);
  const car = await ask("How about car insurance?");
  assert.match(car, /No car insurance charges were found/);
  assert.doesNotMatch(car, /LOWE|PEAK SEASONS|OBGYN|WALGREENS|Blue Cross|578\.05/);

  resetMemoryLedgerForTests();
  assert.equal(
    (
      await upload(
        csv([
          "2026-10-01,GEICO,-90.00",
          "2026-10-02,LOWE'S,-17.06",
          "2026-10-03,CARY OBGYN 919-4675941,-50.00",
          "2026-10-04,BLUE CROSS BLUE SHIELD,-438.44",
        ]),
      )
    ).status,
    200,
  );
  await ask("How much did I spent in insurance?");
  const onlyCar = await ask("How about car insurance?");
  assert.match(onlyCar, /GEICO/);
  assert.match(onlyCar, /Total: \$90\.00/);
  assert.doesNotMatch(onlyCar, /LOWE|OBGYN|Blue Cross/);
  setCompleteChatForTests(null);
});

test("node mode keeps car insurance, medical insurance, and credit-card payments apart", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("rules cover these merchants");
  });
  const uploaded = await upload(
    csv([
      "2026-10-01,GEICO PREM COLL,-104.31",
      "2026-10-02,PROG PREMIER INS PREM,-168.36",
      "2026-10-03,BLUE CROSS BLUE SHIELD,-438.44",
      "2026-10-04,CHASE CREDIT CAUTOPAY,-148.38",
      "2026-10-05,SYNCHRONY BANKPAYMENT,-100.00",
      "2026-10-06,AMEX EPAYMENT ACH PMT,-3.00",
      "2026-10-07,AMEX EPAYMENT ACH PMT,-174.40",
      "2026-10-08,PLANET HOME,-1541.42",
      "2026-10-09,ATT PAYMENT,-100.67",
    ]),
  );
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.uncategorized, 0);

  const bills = await ask("How much did I spent in bills?");
  assert.match(bills, /ATT PAYMENT/);
  assert.doesNotMatch(bills, /Planet Home|1541|GEICO|CHASE/i);

  const mortgage = await ask("How much did I spent in mortgage?");
  assert.match(mortgage, /Planet Home/i);
  assert.match(mortgage, /Total: \$1541\.42/);
  assert.doesNotMatch(mortgage, /ATT|CHASE/);

  const insurance = await ask("How much did I spent in insurance?");
  assert.match(insurance, /Blue Cross Blue Shield/);
  assert.match(insurance, /Total: \$438\.44/);
  assert.doesNotMatch(insurance, /PROG|GEICO|CHASE|AMEX|SYNCHRONY/i);

  const car = await ask("How much did I spend on car insurance?");
  assert.match(car, /GEICO PREM COLL/);
  assert.match(car, /PROG PREMIER INS PREM/);
  assert.match(car, /Total: \$272\.67/);
  assert.doesNotMatch(car, /Blue Cross|CHASE|SYNCHRONY|AMEX|Planet Home/i);

  const cards = await ask("How much did I spend on credit card payments?");
  assert.match(cards, /CHASE CREDIT CAUTOPAY/);
  assert.match(cards, /SYNCHRONY BANKPAYMENT/);
  assert.match(cards, /AMEX EPAYMENT ACH PMT/);
  assert.match(cards, /Total: \$425\.78/);
  assert.doesNotMatch(cards, /GEICO|PROG|Blue Cross|Planet Home|ATT/i);
  setCompleteChatForTests(null);
});

type UploadBody = {
  count?: number;
  added?: number;
  duplicates?: number;
  total?: number;
  error?: string;
};

type Report = {
  loaded: boolean;
  count: number;
  startDate: string | null;
  endDate: string | null;
  uploadedAt: string | null;
};

async function report(): Promise<Report> {
  return (await (await fetch(`${base}/api/report`)).json()) as Report;
}

test("node mode appends a second statement, skips stored rows, and keeps real repeats", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("no model call expected");
  });
  const feb = await upload(
    csv([
      "2026-02-03,FOOD LION,-50.00",
      "2026-02-10,PUBLIX,-30.00",
      "2026-02-11,SHELL OIL,-40.00",
    ]),
  );
  assert.equal(feb.status, 200);
  assert.deepEqual(
    { added: (feb.body as UploadBody).added, total: (feb.body as UploadBody).total },
    { added: 3, total: 3 },
  );
  const first = await report();
  assert.deepEqual(
    { count: first.count, startDate: first.startDate, endDate: first.endDate },
    { count: 3, startDate: "2026-02-03", endDate: "2026-02-11" },
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  const marchCsv = csv([
    // Already stored from February.
    "2026-02-10,PUBLIX,-30.00",
    // Same row, other date and amount formatting.
    "02/11/2026,SHELL OIL,-40",
    "2026-03-05,FOOD LION,-60.00",
    // Two real visits on one day in this file. Both are kept.
    "2026-03-05,FOOD LION,-60.00",
    "2026-04-02,PUBLIX,-25.00",
  ]);
  const march = await upload(marchCsv);
  assert.equal(march.status, 200);
  const body = march.body as UploadBody;
  assert.deepEqual(
    { count: body.count, added: body.added, duplicates: body.duplicates, total: body.total },
    { count: 5, added: 3, duplicates: 2, total: 6 },
  );
  const next = await report();
  assert.deepEqual(
    { loaded: next.loaded, count: next.count, startDate: next.startDate, endDate: next.endDate },
    { loaded: true, count: 6, startDate: "2026-02-03", endDate: "2026-04-02" },
  );
  assert.ok(first.uploadedAt && next.uploadedAt && first.uploadedAt < next.uploadedAt);

  const again = await upload(marchCsv);
  assert.equal(again.status, 200);
  assert.deepEqual(
    {
      added: (again.body as UploadBody).added,
      duplicates: (again.body as UploadBody).duplicates,
      total: (again.body as UploadBody).total,
    },
    { added: 0, duplicates: 5, total: 6 },
  );
  assert.equal((await report()).count, 6);

  const groceries = await ask("How much did I spend on groceries?");
  assert.match(groceries, /Total: \$225\.00/);

  const sinceMarch = await ask("How much did I spend on groceries since March?");
  assert.match(sinceMarch, /60\.00/);
  assert.match(sinceMarch, /25\.00/);
  assert.match(sinceMarch, /Total: \$145\.00/);
  assert.doesNotMatch(sinceMarch, /50\.00|30\.00|SHELL/);

  const range = await ask("How much did I spend on groceries from 2026-02-01 to 2026-03-31?");
  assert.match(range, /Total: \$200\.00/);
  assert.doesNotMatch(range, /25\.00/);
  setCompleteChatForTests(null);
});

test("node mode adds the second copy when a later file has more repeats than the ledger", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("no model call expected");
  });
  // Two real $2.75 visits on one day, as a bus fare would be.
  const fare = "2026-03-01,FOOD LION,-2.75";
  const totals = async (rows: string[]) => {
    const result = await upload(csv(rows));
    assert.equal(result.status, 200);
    const body = result.body as UploadBody;
    return { added: body.added, duplicates: body.duplicates, total: body.total };
  };
  // One fare stored, then the full export with two: the second one is new.
  assert.deepEqual(await totals([fare]), { added: 1, duplicates: 0, total: 1 });
  assert.deepEqual(await totals([fare, fare]), { added: 1, duplicates: 1, total: 2 });
  // The same two again add nothing, and one copy deletes nothing.
  assert.deepEqual(await totals([fare, fare]), { added: 0, duplicates: 2, total: 2 });
  assert.deepEqual(await totals([fare]), { added: 0, duplicates: 1, total: 2 });
  // Three against two stored adds the third, next to another new row.
  assert.deepEqual(
    await totals([fare, "2026-03-02,FOOD LION,-2.75", fare, fare]),
    { added: 2, duplicates: 2, total: 4 },
  );
  assert.equal((await report()).count, 4);
  assert.match(await ask("How much did I spend on groceries?"), /Total: \$11\.00/);
  setCompleteChatForTests(null);
});

test("node mode refuses an upload that would pass the ledger row limit", async () => {
  const rows = (count: number, start: number) =>
    Array.from({ length: count }, (_, index) => {
      const cents = start + index;
      return `2026-01-01,SHELL OIL,-${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
    });
  const first = await upload(csv(rows(15_000, 100)));
  assert.equal(first.status, 200);
  assert.equal((first.body as UploadBody).total, 15_000);

  const over = await upload(csv(rows(6_000, 100_000)));
  assert.equal(over.status, 413);
  assert.match((over.body as UploadBody).error ?? "", /21000 rows\. The limit is 20000\./);
  const after = await report();
  assert.equal(after.count, 15_000);

  // Rows already stored do not count against the limit twice.
  const overlap = await upload(csv([...rows(5_000, 100), ...rows(5_000, 100_000)]));
  assert.equal(overlap.status, 200);
  assert.equal((overlap.body as UploadBody).added, 5_000);
  assert.equal((await report()).count, 20_000);
});

test("node mode reads each upload with its own sign under the same header row", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("no model call expected");
  });
  // Positive charges first, then a signed export with the same headers.
  assert.equal((await upload(csv(["2026-01-02,SHELL OIL,40.00"]))).status, 200);
  assert.equal(
    (await upload(csv(["2026-01-05,EXXON,-25.00", "2026-01-06,DIRECT DEPOSIT ACME PAYROLL,900.00"])))
      .status,
    200,
  );
  const gas = await ask("How much did I spend on gas?");
  assert.match(gas, /Total: \$65\.00/);
  assert.doesNotMatch(gas, /-\$40\.00/);
  const highest = await ask("What was my highest charge?");
  assert.match(highest, /40\.00/);
  assert.doesNotMatch(highest, /900/);
  setCompleteChatForTests(null);
});

test("node mode keeps the saved question when a re-upload adds nothing", async () => {
  const prompts: string[] = [];
  setCompleteChatForTests(async (messages: ChatTurn[]) => {
    prompts.push(messages.map((message) => message.content).join("\n"));
    throw new Error("model down");
  });
  const statement = csv([
    "2026-01-02,CHIPOTLE,-10.00",
    "2026-01-03,MCDONALD'S,-6.00",
    "2026-01-04,SHELL OIL,-40.00",
  ]);
  assert.equal((await upload(statement)).status, 200);
  assert.match(await ask("How much did I spend eating out?"), /Total: \$16\.00/);
  const again = await upload(statement);
  assert.equal(again.status, 200);
  assert.deepEqual(
    {
      added: (again.body as UploadBody).added,
      duplicates: (again.body as UploadBody).duplicates,
      total: (again.body as UploadBody).total,
    },
    { added: 0, duplicates: 3, total: 3 },
  );
  // The follow-up still has the dining question to work from.
  const follow = await ask("exclude chipotle");
  assert.match(follow, /Total: \$6\.00/);
  assert.doesNotMatch(follow, /CHIPOTLE|SHELL/);
  assert.equal(prompts.length, 0);
  setCompleteChatForTests(null);
});

test("node mode answers since March 15 from the day and refuses an unplaced since", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("model down");
  });
  assert.equal(
    (
      await upload(
        csv(["2026-03-02,FOOD LION,-50.00", "2026-03-20,PUBLIX,-30.00", "2026-04-01,PUBLIX,-25.00"]),
      )
    ).status,
    200,
  );
  const day = await ask("How much did I spend on groceries since March 15?");
  assert.match(day, /Total: \$55\.00/);
  assert.doesNotMatch(day, /50\.00/);
  for (const question of ["groceries since last March", "groceries since 3/1"]) {
    const answer = await ask(question);
    assert.match(answer, /couldn't place that date/);
    assert.doesNotMatch(answer, /Total/);
  }
  setCompleteChatForTests(null);
});

test("node mode clears the ledger and interrupts a question in flight", async () => {
  assert.equal((await upload(csv(["2026-01-02,AMAZON.COM,-20.00"]))).status, 200);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  setCompleteChatForTests(async () => {
    markEntered();
    await gate;
    return JSON.stringify({
      categories: ["shopping"],
      merchants: [],
      excludeMerchants: [],
      dateFrom: null,
      dateTo: null,
      op: "sum",
      combine: "or",
    });
  });
  const pending = fetch(`${base}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "How much did I spend on hobbies?" }),
  });
  await entered;
  const cleared = await fetch(`${base}/api/ledger`, { method: "DELETE" });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { ok: true, removed: 1, total: 0 });
  release();
  const response = await pending;
  assert.equal(response.status, 409);
  await response.json();
  assert.deepEqual(
    { loaded: (await report()).loaded, count: (await report()).count },
    { loaded: false, count: 0 },
  );
  const empty = await askRaw("How much did I spend on shopping?");
  assert.equal(empty.status, 400);
  assert.equal((await upload(csv(["2026-02-01,SHELL OIL,-40.00"]))).status, 200);
  assert.equal((await report()).count, 1);
  setCompleteChatForTests(null);
});

test("GET /api/report includes monthly spend-by-category without calling the model", async () => {
  let modelCalls = 0;
  setCompleteChatForTests(async () => {
    modelCalls += 1;
    return "{}";
  });
  const uploaded = await upload(
    csv([
      "2026-11-02,FOOD LION RALEIGH,-40.00",
      "2026-11-03,CHIPOTLE 1234 NC,-18.50",
      "2026-11-04,DIRECT DEPOSIT ACME PAYROLL,900.00",
      "2026-10-15,SHELL OIL,-20.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  const response = await fetch(`${base}/api/report`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    loaded: boolean;
    count: number;
    months: {
      month: string;
      label: string;
      totalCents: number;
      diningCents: number;
      categories: { name: string; cents: number }[];
    }[];
  };
  assert.equal(body.loaded, true);
  assert.equal(body.count, 4);
  assert.equal(modelCalls, 0);
  assert.deepEqual(
    body.months.map((month) => ({
      month: month.month,
      label: month.label,
      totalCents: month.totalCents,
      diningCents: month.diningCents,
    })),
    [
      { month: "2026-10", label: "Oct 2026", totalCents: 2000, diningCents: 0 },
      { month: "2026-11", label: "Nov 2026", totalCents: 5850, diningCents: 1850 },
    ],
  );
  const november = body.months[1];
  assert.ok(november);
  assert.ok(november.categories.some((row) => row.name === "Eating out" && row.cents === 1850));
  assert.ok(november.categories.some((row) => row.name === "Groceries" && row.cents === 4000));
});

test("GET /api/report nets an unsigned Chipotle debit-card return in dining", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("rules cover these merchants");
  });
  const uploaded = await upload(
    csv([
      "2026-11-02,CHIPOTLE,33.04",
      "2026-11-03,DEBIT CARD RETURN CHIPOTLE,10.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  const response = await fetch(`${base}/api/report`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    loaded: boolean;
    count: number;
    months: {
      month: string;
      diningCents: number;
      totalCents: number;
      categories: { name: string; cents: number }[];
    }[];
  };
  assert.equal(body.loaded, true);
  assert.equal(body.count, 2);
  assert.equal(body.months.length, 1);
  const november = body.months[0];
  assert.ok(november);
  assert.equal(november.month, "2026-11");
  assert.equal(november.diningCents, 2304);
  assert.equal(november.totalCents, 2304);
  assert.ok(
    november.categories.some((row) => row.name === "Eating out" && row.cents === 2304),
  );
  setCompleteChatForTests(null);
});

test("GET /api/report merges Chipotle returns and nets an uncategorized Zooplex return", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("rules cover these merchants");
  });
  const uploaded = await upload(
    csv([
      "2026-11-02,DEBIT CARD PURCHASE CHIPOTLE 2210 RALEIGH NC,33.04",
      "2026-11-03,DEBIT CARD RETURN CHIPOTLE 2210 RALEIGH NC,10.00",
      "2026-11-04,ZOOPLEX GADGETS 99,50.00",
      "2026-11-05,DEBIT CARD RETURN ZOOPLEX GADGETS 99,20.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  const response = await fetch(`${base}/api/report`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    loaded: boolean;
    count: number;
    months: {
      month: string;
      diningCents: number;
      totalCents: number;
      categories: { name: string; cents: number }[];
      topMerchants: { name: string; cents: number }[];
    }[];
  };
  assert.equal(body.loaded, true);
  assert.equal(body.count, 4);
  assert.equal(body.months.length, 1);
  const november = body.months[0];
  assert.ok(november);
  assert.equal(november.month, "2026-11");
  assert.equal(november.diningCents, 2304);
  assert.equal(november.totalCents, 5304);
  assert.ok(
    november.categories.some((row) => row.name === "Eating out" && row.cents === 2304),
  );
  assert.ok(
    november.categories.some((row) => row.name === "Other" && row.cents === 3000),
  );
  assert.deepEqual(november.topMerchants, [
    { name: "ZOOPLEX GADGETS", cents: 3000 },
    { name: "CHIPOTLE", cents: 2304 },
  ]);
  setCompleteChatForTests(null);
});

test("POST /api/query nets an unsigned Chipotle purchase and return to match the report", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("rules cover these merchants");
  });
  const uploaded = await upload(
    csv([
      "2026-11-02,DEBIT CARD PURCHASE CHIPOTLE 2210 RALEIGH NC,33.04",
      "2026-11-03,DEBIT CARD RETURN CHIPOTLE 2210 RALEIGH NC,10.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  const report = await fetch(`${base}/api/report`);
  assert.equal(report.status, 200);
  const body = (await report.json()) as {
    months: { diningCents: number }[];
  };
  assert.equal(body.months[0]?.diningCents, 2304);
  const eating = await ask("How much I spent eating out?");
  assert.match(eating, /Total: \$23\.04/);
  const chipotle = await ask("How much did I spend at Chipotle?");
  assert.match(chipotle, /Total: \$23\.04/);
  setCompleteChatForTests(null);
});

test("POST /api/query nets a signed return at an Other merchant", async () => {
  setCompleteChatForTests(async (messages: ChatTurn[]) => {
    const blob = messages.map((message) => message.content).join("\n");
    if (!blob.includes("ZOOPLEX")) {
      throw new Error("rules cover these merchants");
    }
    return JSON.stringify({
      items: [
        { merchant: "ZOOPLEX GADGETS 99", category: "other" },
        { merchant: "DEBIT CARD RETURN ZOOPLEX GADGETS 99", category: "other" },
      ],
    });
  });
  const uploaded = await upload(
    csv([
      "2026-11-04,ZOOPLEX GADGETS 99,-50.00",
      "2026-11-05,DEBIT CARD RETURN ZOOPLEX GADGETS 99,-20.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.uncategorized, 0);
  const answer = await ask("How much did I spend at Zooplex?");
  assert.match(answer, /Total: \$30\.00/);
  setCompleteChatForTests(null);
});

type ReportMonth = {
  month: string;
  totalCents: number;
  diningCents: number;
  categories: { name: string; cents: number }[];
  topMerchants: { name: string; cents: number }[];
};

async function reportMonths(): Promise<ReportMonth[]> {
  const report = await fetch(`${base}/api/report`);
  assert.equal(report.status, 200);
  return ((await report.json()) as { months: ReportMonth[] }).months;
}

function categoryStub(assignments: Record<string, string>) {
  return async (messages: ChatTurn[]) => {
    const blob = messages.map((message) => message.content).join("\n");
    if (!blob.includes("You assign exactly one category")) {
      throw new Error("no live model in tests");
    }
    const names = (messages[1]?.content ?? "")
      .split("\n")
      .slice(1)
      .map((line) => line.replace(/^\d+\.\s/, ""));
    return JSON.stringify({
      items: names.map((merchant) => ({
        merchant,
        category:
          Object.entries(assignments).find(([key]) => merchant.includes(key))?.[1] ??
          "other",
      })),
    });
  };
}

test("an unsigned bare RETURN with a matching purchase nets into one merchant row", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("rules cover these merchants");
  });
  const uploaded = await upload(
    csv([
      "2026-11-02,DEBIT CARD PURCHASE CHIPOTLE 2210 RALEIGH NC,33.04",
      "2026-11-03,RETURN CHIPOTLE 2210 RALEIGH NC,10.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  const [november] = await reportMonths();
  assert.ok(november);
  assert.equal(november.totalCents, 2304);
  assert.equal(november.diningCents, 2304);
  assert.deepEqual(november.topMerchants, [{ name: "CHIPOTLE", cents: 2304 }]);
  const chipotle = await ask("How much did I spend at Chipotle?");
  assert.match(chipotle, /CHIPOTLE: -\$10\.00/);
  assert.match(chipotle, /Total: \$23\.04/);
  assert.doesNotMatch(chipotle, /RETURN CHIPOTLE/);
  const total = await ask("What did I spend in total?");
  assert.match(total, /Total: \$23\.04/);
  setCompleteChatForTests(null);
});

test("an unsigned bare RETURN nets against a purchase from an earlier upload", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("rules cover these merchants");
  });
  assert.equal(
    (await upload(csv(["2026-11-02,CHIPOTLE 2210 RALEIGH NC,33.04"]))).status,
    200,
  );
  assert.equal(
    (await upload(csv(["2026-11-03,RETURN CHIPOTLE 2210 RALEIGH NC,10.00"]))).status,
    200,
  );
  const [november] = await reportMonths();
  assert.deepEqual(november?.topMerchants, [{ name: "CHIPOTLE", cents: 2304 }]);
  const chipotle = await ask("How much did I spend at Chipotle?");
  assert.match(chipotle, /Total: \$23\.04/);
  setCompleteChatForTests(null);
});

test("unsigned RETURN-named charges with no matching purchase stay charges with full names", async () => {
  setCompleteChatForTests(
    categoryStub({
      "RETURN ITEM FEE": "other",
      "MAC CAFE": "dining",
      "RETURNED CHECK FEE": "other",
      "RETURNS INC": "shopping",
    }),
  );
  const uploaded = await upload(
    csv([
      "2026-02-01,RETURN ITEM FEE,12.00",
      "2026-02-02,RETURN OF THE MAC CAFE,18.00",
      "2026-02-03,COSTCO WHSE #123,40.00",
      "2026-02-04,RETURNS INC STORE,45.00",
      "2026-02-05,RETURNED CHECK FEE,35.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  const [february] = await reportMonths();
  assert.ok(february);
  assert.equal(february.totalCents, 15000);
  assert.equal(february.diningCents, 1800);
  assert.deepEqual(february.topMerchants, [
    { name: "RETURNS INC STORE", cents: 4500 },
    { name: "Costco", cents: 4000 },
    { name: "RETURNED CHECK FEE", cents: 3500 },
    { name: "RETURN OF THE MAC CAFE", cents: 1800 },
    { name: "RETURN ITEM FEE", cents: 1200 },
  ]);
  const total = await ask("What did I spend in total?");
  assert.match(total, /RETURN ITEM FEE: \$12\.00/);
  assert.match(total, /RETURN OF THE MAC CAFE: \$18\.00/);
  assert.match(total, /Total: \$150\.00/);
  setCompleteChatForTests(null);
});

test("unsigned RETURN COSTCO nets only with a Costco purchase; RETURN TARGET alone stays a charge", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("rules cover these merchants");
  });
  const uploaded = await upload(
    csv([
      "2026-03-01,COSTCO WHSE #123,86.20",
      "2026-03-02,RETURN COSTCO WHSE #123,20.00",
      "2026-03-03,RETURN TARGET T-1234,15.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  const [march] = await reportMonths();
  assert.ok(march);
  assert.equal(march.totalCents, 6620 + 1500);
  assert.deepEqual(march.topMerchants, [
    { name: "Costco", cents: 6620 },
    { name: "RETURN TARGET T-1234", cents: 1500 },
  ]);
  const total = await ask("What did I spend in total?");
  assert.match(total, /Costco: -\$20\.00/);
  assert.match(total, /RETURN TARGET T-1234: \$15\.00/);
  assert.match(total, /Total: \$81\.20/);
  setCompleteChatForTests(null);
});

for (const label of ["other", null] as const) {
  test(`signed RETURN DIRECT DEPOSIT stays income when the model says ${label ?? "nothing"}`, async () => {
    setCompleteChatForTests(
      label
        ? categoryStub({ PAYROLL: label })
        : async () => {
            throw new Error("model unavailable");
          },
    );
    const uploaded = await upload(
      csv([
        "2026-03-01,DIRECT DEPOSIT ACME PAYROLL,2000.00",
        "2026-03-02,RETURN DIRECT DEPOSIT ACME PAYROLL,2000.00",
        "2026-03-04,DEBIT CARD RETURN PAYROLL CARD,25.00",
        "2026-03-07,COSTCO WHSE #123,-60.00",
      ]),
    );
    assert.equal(uploaded.status, 200);
    const [march] = await reportMonths();
    assert.ok(march);
    assert.equal(march.totalCents, 6000);
    assert.deepEqual(march.topMerchants, [{ name: "Costco", cents: 6000 }]);
    assert.equal(
      march.categories.some((row) => row.cents < 0),
      false,
    );
    const total = await ask("What did I spend in total?");
    assert.match(total, /Total: \$60\.00/);
    assert.doesNotMatch(total, /-\$2000\.00|PAYROLL/);
    setCompleteChatForTests(null);
  });
}

test("the income list tells a deposit apart from its RETURN line", async () => {
  setCompleteChatForTests(categoryStub({ PAYROLL: "income" }));
  const uploaded = await upload(
    csv([
      "2026-03-01,DIRECT DEPOSIT ACME PAYROLL,2000.00",
      "2026-03-02,RETURN DIRECT DEPOSIT ACME PAYROLL,2000.00",
      "2026-03-07,COSTCO WHSE #123,-60.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  const income = await ask("How much income did I get?");
  assert.match(income, /^DIRECT DEPOSIT ACME PAYROLL: \$2000\.00$/m);
  assert.match(income, /^RETURN DIRECT DEPOSIT ACME PAYROLL: \$2000\.00$/m);
  setCompleteChatForTests(null);
});

test("a signed money-in bare RETURN nets and merges with the purchase", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("rules cover these merchants");
  });
  const uploaded = await upload(
    csv([
      "2026-11-02,DEBIT CARD PURCHASE CHIPOTLE 2210 RALEIGH NC,-33.04",
      "2026-11-03,RETURN CHIPOTLE 2210 RALEIGH NC,10.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  const report = await fetch(`${base}/api/report`);
  assert.equal(report.status, 200);
  const body = (await report.json()) as {
    months: { diningCents: number; topMerchants: { name: string; cents: number }[] }[];
  };
  assert.equal(body.months[0]?.diningCents, 2304);
  assert.deepEqual(body.months[0]?.topMerchants, [
    { name: "CHIPOTLE", cents: 2304 },
  ]);
  const chipotle = await ask("How much did I spend at Chipotle?");
  assert.match(chipotle, /Total: \$23\.04/);
  setCompleteChatForTests(null);
});

test("signed charges that start with RETURN stay spend and keep their names", async () => {
  setCompleteChatForTests(async (messages: ChatTurn[]) => {
    const blob = messages.map((message) => message.content).join("\n");
    if (blob.includes("You assign exactly one category")) {
      return JSON.stringify({
        items: [
          { merchant: "RETURN ITEM FEE", category: "other" },
          { merchant: "RETURN OF THE MAC CAFE", category: "dining" },
        ],
      });
    }
    throw new Error("rules cover these merchants");
  });
  const uploaded = await upload(
    csv([
      "2026-02-01,RETURN ITEM FEE,-12.00",
      "2026-02-02,RETURN OF THE MAC CAFE,-18.00",
      "2026-02-03,COSTCO,-40.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  const report = await fetch(`${base}/api/report`);
  assert.equal(report.status, 200);
  const body = (await report.json()) as {
    months: {
      totalCents: number;
      diningCents: number;
      topMerchants: { name: string; cents: number }[];
    }[];
  };
  const february = body.months[0];
  assert.ok(february);
  assert.equal(february.totalCents, 7000);
  assert.equal(february.diningCents, 1800);
  assert.deepEqual(february.topMerchants, [
    { name: "Costco", cents: 4000 },
    { name: "RETURN OF THE MAC CAFE", cents: 1800 },
    { name: "RETURN ITEM FEE", cents: 1200 },
  ]);
  const total = await ask("What did I spend in total?");
  assert.match(total, /Total: \$70\.00/);
  assert.match(total, /RETURN ITEM FEE: \$12\.00/);
  assert.match(total, /RETURN OF THE MAC CAFE: \$18\.00/);
  const eating = await ask("eating out");
  assert.match(eating, /Total: \$18\.00/);
  setCompleteChatForTests(null);
});

test("a signed positive DEBIT CARD RETURN at an unruly merchant nets in Other, not income", async () => {
  setCompleteChatForTests(async (messages: ChatTurn[]) => {
    const blob = messages.map((message) => message.content).join("\n");
    if (!blob.includes("ZOOPLEX")) {
      throw new Error("rules cover these merchants");
    }
    return JSON.stringify({
      items: [
        { merchant: "ZOOPLEX GADGETS 99", category: "other" },
        { merchant: "DEBIT CARD RETURN ZOOPLEX GADGETS 99", category: "other" },
      ],
    });
  });
  const uploaded = await upload(
    csv([
      "2026-06-06,ZOOPLEX GADGETS 99,-50.00",
      "2026-06-07,DEBIT CARD RETURN ZOOPLEX GADGETS 99,20.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.uncategorized, 0);
  const report = await fetch(`${base}/api/report`);
  assert.equal(report.status, 200);
  const body = (await report.json()) as {
    months: { totalCents: number; categories: { name: string; cents: number }[] }[];
  };
  const june = body.months[0];
  assert.ok(june);
  assert.equal(june.totalCents, 3000);
  assert.ok(
    june.categories.some((row) => row.name === "Other" && row.cents === 3000),
  );
  assert.equal(
    june.categories.some((row) => row.name.toLowerCase().includes("income")),
    false,
  );
  const answer = await ask("How much did I spend at Zooplex?");
  assert.match(answer, /Total: \$30\.00/);
  setCompleteChatForTests(null);
});

// After #11, a debit-card return with no merchant rule is left to the model
// (Other) so it can net against spending. These tests stub that one answer.
// Any other model call (such as a question's intent) still fails.
function grokReturnIsOther(): (messages: ChatTurn[]) => Promise<string> {
  return async (messages) => {
    if (!messages[0]?.content.startsWith("You assign exactly one category")) {
      throw new Error("no live model in tests");
    }
    return JSON.stringify({
      items: [{ merchant: "DEBIT CARD RETURN GROK XAI PALO ALTO", category: "other" }],
    });
  };
}

test("node mode returns only payroll, dividends, and interest for an income question", async () => {
  setCompleteChatForTests(grokReturnIsOther());
  const uploaded = await upload(
    csv([
      "2026-10-01,DIVIDEND RECEIVED FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (CASH),2.00",
      "2026-10-02,INTEREST EARNED FDIC INSURED DEPOSIT AT JP MORGAN HS (QHZHQ) (CASH) HSA NOT COVERED BY SIPC,0.02",
      "2026-10-03,INTEREST EARNED FDIC INSURED DEPOSIT AT US BANK NOT (QUSBQ),0.01",
      "2026-10-04,INTEREST EARNED FDIC INSURED DEPOSIT AT WELLS FARGO (QPIQQ) BK NOT COVERED BY SIPC,2.16",
      "2026-10-05,DIRECT DEPOSIT PAYPAL TRANSFER,505.00",
      "2026-10-06,DIRECT DEPOSIT ELSEVIER INCPAYROLL,2785.11",
      "2026-10-07,ADVS ED SERV PSTUDNTLOAN,138.33",
      "2026-10-08,DEBIT CARD RETURN GROK XAI PALO ALTO,0.15",
      "2026-10-09,ADJUST FEE CHARGED ATM FEE REBATE,3.00",
      "2026-10-10,DIRECT DEPOSIT ELSEVIER INCPAYROLL,2785.12",
      "2026-10-11,TRANSFERRED FROM VS X84-544623-1,185.00",
      "2026-10-12,MY529 INVESTMENT,100.00",
      "2026-10-13,DIRECT DEPOSIT ELSEVIER INCPAYROLL,2785.13",
    ]),
  );
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.uncategorized, 0);
  const answer = await ask("How much was income?");
  assert.match(answer, /Total: \$8359\.55/);
  assert.match(answer, /2785\.11/);
  assert.match(answer, /2785\.12/);
  assert.match(answer, /2785\.13/);
  assert.match(answer, /\$2\.00/);
  assert.match(answer, /\$0\.02/);
  assert.match(answer, /\$0\.01/);
  assert.match(answer, /\$2\.16/);
  assert.doesNotMatch(answer, /PAYPAL/);
  assert.doesNotMatch(answer, /505\.00/);
  assert.doesNotMatch(answer, /STUDNTLOAN/);
  assert.doesNotMatch(answer, /138\.33/);
  assert.doesNotMatch(answer, /DEBIT CARD RETURN/);
  assert.doesNotMatch(answer, /0\.15/);
  assert.doesNotMatch(answer, /FEE REBATE/);
  assert.doesNotMatch(answer, /\$3\.00/);
  assert.doesNotMatch(answer, /TRANSFERRED FROM/);
  assert.doesNotMatch(answer, /185\.00/);
  assert.doesNotMatch(answer, /MY529/);
  assert.doesNotMatch(answer, /100\.00/);
  setCompleteChatForTests(null);
});

test("node mode nets a debit-card return against dining and keeps income at $8359.55", async () => {
  setCompleteChatForTests(grokReturnIsOther());
  const uploaded = await upload(
    csv([
      "2026-09-30,CHIPOTLE,-33.04",
      "2026-09-30,DEBIT CARD RETURN CHIPOTLE,10.00",
      "2026-10-01,DIVIDEND RECEIVED FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (CASH),2.00",
      "2026-10-02,INTEREST EARNED FDIC INSURED DEPOSIT AT JP MORGAN HS (QHZHQ) (CASH) HSA NOT COVERED BY SIPC,0.02",
      "2026-10-03,INTEREST EARNED FDIC INSURED DEPOSIT AT US BANK NOT (QUSBQ),0.01",
      "2026-10-04,INTEREST EARNED FDIC INSURED DEPOSIT AT WELLS FARGO (QPIQQ) BK NOT COVERED BY SIPC,2.16",
      "2026-10-05,DIRECT DEPOSIT PAYPAL TRANSFER,505.00",
      "2026-10-06,DIRECT DEPOSIT ELSEVIER INCPAYROLL,2785.11",
      "2026-10-07,ADVS ED SERV PSTUDNTLOAN,138.33",
      "2026-10-08,DEBIT CARD RETURN GROK XAI PALO ALTO,0.15",
      "2026-10-09,ADJUST FEE CHARGED ATM FEE REBATE,3.00",
      "2026-10-10,DIRECT DEPOSIT ELSEVIER INCPAYROLL,2785.12",
      "2026-10-11,TRANSFERRED FROM VS X84-544623-1,185.00",
      "2026-10-12,MY529 INVESTMENT,100.00",
      "2026-10-13,DIRECT DEPOSIT ELSEVIER INCPAYROLL,2785.13",
    ]),
  );
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.uncategorized, 0);
  const dining = await ask("How much I spent eating out?");
  assert.match(dining, /CHIPOTLE/);
  assert.match(dining, /Total: \$23\.04/);
  assert.match(dining, /-\$10\.00/);
  const income = await ask("How much was income?");
  assert.match(income, /Total: \$8359\.55/);
  assert.doesNotMatch(income, /CHIPOTLE/);
  assert.doesNotMatch(income, /PAYPAL/);
  assert.doesNotMatch(income, /GROK/);
  assert.doesNotMatch(income, /FEE REBATE/);
  assert.doesNotMatch(income, /MY529/);
  assert.doesNotMatch(income, /STUDNTLOAN/);
  const earned = await ask("How much did I earn?");
  assert.match(earned, /Total: \$8359\.55/);
  assert.doesNotMatch(earned, /PAYPAL/);
  const both = await ask("How much was income and transfers?");
  assert.match(both, /2785\.11/);
  assert.match(both, /PAYPAL/);
  // The GROK debit-card return ($0.15) is Other now, not a transfer.
  assert.match(both, /Total: \$9290\.88/);
  assert.doesNotMatch(both, /CHIPOTLE/);
  setCompleteChatForTests(null);
});

test("node mode leaves a bare DIRECT DEPOSIT to the model on a new upload", async () => {
  setCompleteChatForTests(async () => {
    throw new Error("rules do not cover a bare direct deposit");
  });
  const uploaded = await upload(
    csv([
      "2026-10-01,CHIPOTLE,-10.00",
      "2026-10-02,DIRECT DEPOSIT ACME,500.00",
      "2026-10-03,DIR DEP ACME CORP,900.00",
    ]),
  );
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.uncategorized, 1);
  const income = await ask("How much was income?");
  assert.match(income, /Total: \$900\.00/);
  assert.match(income, /DIR DEP/);
  assert.doesNotMatch(income, /DIRECT DEPOSIT ACME/);
  setCompleteChatForTests(null);
});

test("node mode nets an unsigned debit-card return against dining", async () => {
  setCompleteChatForTests(grokReturnIsOther());
  const uploaded = await upload(
    csv([
      "2026-09-30,CHIPOTLE,33.04",
      "2026-09-30,DEBIT CARD RETURN CHIPOTLE,10.00",
      "2026-10-01,DIVIDEND RECEIVED FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (CASH),2.00",
      "2026-10-02,INTEREST EARNED FDIC INSURED DEPOSIT AT JP MORGAN HS (QHZHQ) (CASH) HSA NOT COVERED BY SIPC,0.02",
      "2026-10-03,INTEREST EARNED FDIC INSURED DEPOSIT AT US BANK NOT (QUSBQ),0.01",
      "2026-10-04,INTEREST EARNED FDIC INSURED DEPOSIT AT WELLS FARGO (QPIQQ) BK NOT COVERED BY SIPC,2.16",
      "2026-10-05,DIRECT DEPOSIT PAYPAL TRANSFER,505.00",
      "2026-10-06,DIRECT DEPOSIT ELSEVIER INCPAYROLL,2785.11",
      "2026-10-07,ADVS ED SERV PSTUDNTLOAN,138.33",
      "2026-10-08,DEBIT CARD RETURN GROK XAI PALO ALTO,0.15",
      "2026-10-09,ADJUST FEE CHARGED ATM FEE REBATE,3.00",
      "2026-10-10,DIRECT DEPOSIT ELSEVIER INCPAYROLL,2785.12",
      "2026-10-11,TRANSFERRED FROM VS X84-544623-1,185.00",
      "2026-10-12,MY529 INVESTMENT,100.00",
      "2026-10-13,DIRECT DEPOSIT ELSEVIER INCPAYROLL,2785.13",
    ]),
  );
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.uncategorized, 0);
  const dining = await ask("How much I spent eating out?");
  assert.match(dining, /Total: \$23\.04/);
  assert.doesNotMatch(dining, /\$43\.04/);
  const income = await ask("How much was income?");
  assert.match(income, /Total: \$8359\.55/);
  assert.doesNotMatch(income, /CHIPOTLE/);
  setCompleteChatForTests(null);
});

test("node mode nets a signed-negative debit-card return against dining", async () => {
  setCompleteChatForTests(grokReturnIsOther());
  const uploaded = await upload(
    csv([
      "2026-09-30,CHIPOTLE,-33.04",
      "2026-09-30,DEBIT CARD RETURN CHIPOTLE,-10.00",
      "2026-10-01,DIVIDEND RECEIVED FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (CASH),2.00",
      "2026-10-02,INTEREST EARNED FDIC INSURED DEPOSIT AT JP MORGAN HS (QHZHQ) (CASH) HSA NOT COVERED BY SIPC,0.02",
      "2026-10-03,INTEREST EARNED FDIC INSURED DEPOSIT AT US BANK NOT (QUSBQ),0.01",
      "2026-10-04,INTEREST EARNED FDIC INSURED DEPOSIT AT WELLS FARGO (QPIQQ) BK NOT COVERED BY SIPC,2.16",
      "2026-10-05,DIRECT DEPOSIT PAYPAL TRANSFER,505.00",
      "2026-10-06,DIRECT DEPOSIT ELSEVIER INCPAYROLL,2785.11",
      "2026-10-07,ADVS ED SERV PSTUDNTLOAN,138.33",
      "2026-10-08,DEBIT CARD RETURN GROK XAI PALO ALTO,0.15",
      "2026-10-09,ADJUST FEE CHARGED ATM FEE REBATE,3.00",
      "2026-10-10,DIRECT DEPOSIT ELSEVIER INCPAYROLL,2785.12",
      "2026-10-11,TRANSFERRED FROM VS X84-544623-1,185.00",
      "2026-10-12,MY529 INVESTMENT,100.00",
      "2026-10-13,DIRECT DEPOSIT ELSEVIER INCPAYROLL,2785.13",
    ]),
  );
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.uncategorized, 0);
  const dining = await ask("How much I spent eating out?");
  assert.match(dining, /Total: \$23\.04/);
  assert.doesNotMatch(dining, /\$43\.04/);
  const income = await ask("How much was income?");
  assert.match(income, /Total: \$8359\.55/);
  assert.doesNotMatch(income, /CHIPOTLE/);
  const made = await ask("How much did I make?");
  assert.match(made, /Total: \$8359\.55/);
  assert.doesNotMatch(made, /PAYPAL/);
  setCompleteChatForTests(null);
});
