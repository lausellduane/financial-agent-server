import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { setCompleteChatForTests, type ChatTurn } from "./llm.ts";
import { app } from "./server.ts";

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

test("node mode drops question context when the statement is replaced", async () => {
  setCompleteChatForTests(async () =>
    JSON.stringify({
      categories: ["gas/auto"],
      merchants: [],
      excludeMerchants: [],
      dateFrom: null,
      dateTo: null,
      op: "sum",
      combine: "or",
    }),
  );
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
  const follow = await ask("exclude chipotle");
  assert.match(follow, /SHELL/);
  assert.doesNotMatch(follow, /STARBUCKS/);
  assert.doesNotMatch(follow, /CHIPOTLE/);
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
      "2026-10-16,SHELL OIL,-40.00",
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
  assert.doesNotMatch(bills, /LOWE|PEAK SEASONS|17\.06|38\.00|17\.16|SHELL OIL/);

  const mortgage = await ask("How much did I spent in mortgage?");
  assert.match(mortgage, /MR COOPER/);
  assert.match(mortgage, /Total: \$1510\.00/);
  assert.doesNotMatch(mortgage, /LOWE|PEAK SEASONS|72\.22/);

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
