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
  const response = await fetch(`${base}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { answer?: string };
  return body.answer ?? "";
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
  assert.doesNotMatch(JSON.stringify(body), /9\.50/);
  setCompleteChatForTests(null);
});
