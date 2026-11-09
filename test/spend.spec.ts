import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { categorizeNarrative, parseCategoryAssignments } from "../categories.ts";
import { LEDGER_MIGRATION } from "../ledger.ts";
import {
  buildIntentMessages,
  formatAnswer,
  intentFromModel,
  interpretQuestion,
  selectTransactions,
  totalCents,
  validateIntent,
  type QueryIntent,
  type TxView,
} from "../query-intent.ts";
import { cleanMerchantName, formatCents, parseAmountCents } from "../statement.ts";

const ISSUER = "https://testteam.cloudflareaccess.com";
const AUD = "test-aud";
const CERTS = `${ISSUER}/cdn-cgi/access/certs`;

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwksBody = "";

const handler = exports.default as {
  fetch(request: Request): Promise<Response>;
};

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwksBody = JSON.stringify({ keys: [jwk] });
});

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url === CERTS) {
      return new Response(jwksBody, {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function ledgerName(email: string): string {
  return `sub:sub-${email}`;
}

async function tokenFor(email: string): Promise<string> {
  return new SignJWT({ type: "app", email, sub: `sub-${email}` })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
}

function authed(path: string, token: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Cf-Access-Jwt-Assertion", token);
  return handler.fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
  );
}

function view(description: string, amount: string, signed: boolean): TxView {
  const amountCents = parseAmountCents(amount);
  const found = categorizeNarrative(description, amountCents, signed);
  return {
    date: "2026-01-15",
    merchant: cleanMerchantName(description),
    narrative: description.toUpperCase(),
    amountCents,
    spendCents: signed ? -amountCents : Math.abs(amountCents),
    category: found === "unknown" ? "other" : found,
  };
}

const screenshotRows: Array<[string, string]> = [
  ["CHIPOTLE", "-33.04"],
  ["DIRECT DEPOSIT ELSEVIER INCPAYROLL", "2785.11"],
  ["KRISPY KREME", "-5.61"],
  ["THE YARD MILKSHAKE BAR RALEIGH", "-19.00"],
  ["NETFLIX.COM NETFLIX.COM", "-21.44"],
  ["MCDONALD'S", "-26.17"],
  ["SQ *SHAKE SHACK RALEIGH", "-48.75"],
  ["CHICK-FIL-A", "-34.19"],
  ["SQ *THE CUB HOUSE PLAY GOSQ.COM", "-23.99"],
  ["LOWE'S FOODS", "-38.33"],
  ["CHIPOTLE", "-26.79"],
  ["CARY OBGYN 919-4675941", "-50.00"],
  ["DIRECT DEPOSIT ELSEVIER INCPAYROLL", "2785.12"],
  ["BAD DADDY'S BURGER BAR RALEIGH", "-57.34"],
  ["ATT PAYMENT", "-100.67"],
  ["CHIPOTLE", "-30.00"],
  ["CHICK-FIL-A", "-30.34"],
  ["RING SOLO PLAN RING.COM", "-4.99"],
  ["GOOGLE*G1SK003M 650-2530000", "-9.99"],
  ["CHICK-FIL-A", "-29.04"],
  ["PEAK SEASONS HVAC PEAKSEASONSHV NC100126", "-17.16"],
  ["PAYPAL *LAUSELL DUANE VISA DIRECT", "-100.00"],
  ["Amazon Web Services", "-181.64"],
  ["TROPICAL SMOOTHIE CAFE GARNER", "-36.98"],
  ["DIRECT DEPOSIT ELSEVIER INCPAYROLL", "2785.13"],
];

function screenshotViews(): TxView[] {
  return screenshotRows.map(([description, amount]) => view(description, amount, true));
}

function answerFor(
  question: string,
  txs: TxView[],
  previous: QueryIntent | null = null,
): { answer: string; intent: QueryIntent } {
  const known = txs.flatMap((tx) => [tx.narrative, tx.merchant]);
  const interpreted = interpretQuestion(question, previous, known);
  expect(interpreted?.confident).toBe(true);
  const intent = interpreted?.intent;
  if (!intent) throw new Error("missing intent");
  const matched = selectTransactions(txs, intent);
  return { answer: formatAnswer(matched, intent), intent };
}

function lineTotal(answer: string): number {
  let cents = 0;
  for (const line of answer.split("\n")) {
    if (line.startsWith("Total")) continue;
    const match = line.match(/: (-?)\$(\d+)\.(\d{2})$/);
    if (!match?.[2] || !match[3]) continue;
    const sign = match[1] === "-" ? -1 : 1;
    cents += sign * (Number(match[2]) * 100 + Number(match[3]));
  }
  return cents;
}

describe("categorizeNarrative", () => {
  it("tags the screenshot merchants with the rules", () => {
    const txs = screenshotViews();
    const byDescription = new Map(txs.map((tx) => [tx.narrative, tx.category]));
    expect(byDescription.get("CHIPOTLE")).toBe("dining");
    expect(byDescription.get("KRISPY KREME")).toBe("dining");
    expect(byDescription.get("THE YARD MILKSHAKE BAR RALEIGH")).toBe("dining");
    expect(byDescription.get("MCDONALD'S")).toBe("dining");
    expect(byDescription.get("SQ *SHAKE SHACK RALEIGH")).toBe("dining");
    expect(byDescription.get("CHICK-FIL-A")).toBe("dining");
    expect(byDescription.get("BAD DADDY'S BURGER BAR RALEIGH")).toBe("dining");
    expect(byDescription.get("TROPICAL SMOOTHIE CAFE GARNER")).toBe("dining");
    expect(byDescription.get("LOWE'S FOODS")).toBe("groceries");
    expect(byDescription.get("LOWE'S #456")).toBeUndefined();
    expect(categorizeNarrative("LOWE'S #456", -4200, true)).toBe("home");
    expect(byDescription.get("DIRECT DEPOSIT ELSEVIER INCPAYROLL")).toBe("income");
    expect(byDescription.get("NETFLIX.COM NETFLIX.COM")).toBe("subscriptions");
    expect(byDescription.get("RING SOLO PLAN RING.COM")).toBe("subscriptions");
    expect(byDescription.get("GOOGLE*G1SK003M 650-2530000")).toBe("subscriptions");
    expect(byDescription.get("ATT PAYMENT")).toBe("utilities/telecom");
    expect(byDescription.get("CARY OBGYN 919-4675941")).toBe("healthcare");
    expect(byDescription.get("AMAZON WEB SERVICES")).toBe("cloud/software");
    expect(byDescription.get("PAYPAL *LAUSELL DUANE VISA DIRECT")).toBe("transfers");
    expect(byDescription.get("PEAK SEASONS HVAC PEAKSEASONSHV NC100126")).toBe("home");
    expect(byDescription.get("SQ *THE CUB HOUSE PLAY GOSQ.COM")).toBe("other");
    expect(categorizeNarrative("PIEDMONT NATURAL GAS", -4000, true)).toBe(
      "utilities/telecom",
    );
    expect(categorizeNarrative("SHELL OIL 12", -4000, true)).toBe("gas/auto");
  });

  it("keeps a merchant refund in its spending category and treats unmatched credits as income", () => {
    expect(categorizeNarrative("CHIPOTLE", 3304, true)).toBe("dining");
    expect(categorizeNarrative("AMAZON.COM", 500, true)).toBe("shopping");
    expect(categorizeNarrative("CHIPOTLE", 3304, false)).toBe("dining");
    expect(categorizeNarrative("MYSTERY CREDIT 42", 500, true)).toBe("income");
    expect(categorizeNarrative("DIRECT DEPOSIT ACME PAYROLL", 100, false)).toBe(
      "income",
    );
    expect(categorizeNarrative("PAYPAL *JANE VISA DIRECT", 5000, true)).toBe(
      "transfers",
    );
  });

  it("parses model category assignments and drops unknown labels", () => {
    const assigned = parseCategoryAssignments(
      'Sure ```json\n{"items":[{"merchant":"ZOOPLEX SNACKBAR 12","category":"dining"},{"merchant":"NOPE","category":"yacht"}]}\n```',
      ["ZOOPLEX SNACKBAR 12"],
    );
    expect(assigned.get("ZOOPLEX SNACKBAR 12")).toBe("dining");
    expect(assigned.has("NOPE")).toBe(false);
  });
});

describe("intent validation and aggregation", () => {
  it("accepts a structured intent and rejects row indexes", () => {
    const valid = validateIntent({
      categories: ["dining", "dining"],
      merchants: ["chipotle"],
      excludeMerchants: [],
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      op: "sum",
      combine: "or",
    });
    expect(valid?.categories).toEqual(["dining"]);
    expect(valid?.op).toBe("sum");
    expect(validateIntent({ indexes: [1, 2, 3] })).toBeNull();
    expect(
      validateIntent({
        categories: ["dining"],
        merchants: [],
        op: "sum",
        dateFrom: "2026-02-01",
        dateTo: "2026-01-01",
      }),
    ).toBeNull();
    expect(interpretQuestion("   ", null, [])).toBeNull();
    expect(validateIntent({ categories: ["food"], op: "sum" })).toBeNull();
    expect(
      validateIntent({ categories: ["dining"], op: "average", merchants: [] }),
    ).toBeNull();
    expect(
      validateIntent({
        categories: ["dining"],
        merchants: [],
        op: "sum",
        dateFrom: "2026-13-01",
        dateTo: null,
      }),
    ).toBeNull();
    expect(
      intentFromModel(
        '{"indexes":[1,2,3]}',
        "How much I spent eating out?",
      ),
    ).toBeNull();
  });

  it("strips income the model added to a spending question", () => {
    const intent = intentFromModel(
      JSON.stringify({
        categories: ["income", "dining"],
        merchants: [],
        excludeMerchants: [],
        dateFrom: null,
        dateTo: null,
        op: "sum",
      }),
      "How much I spent eating out?",
    );
    expect(intent?.categories).toEqual(["dining"]);
    const onlyIncome = intentFromModel(
      JSON.stringify({
        categories: ["income"],
        merchants: [],
        op: "sum",
      }),
      "How much I spent eating out?",
    );
    expect(onlyIncome?.scope).toBe("filtered");
    expect(onlyIncome?.categories).toEqual([]);
    const txs = screenshotViews();
    expect(selectTransactions(txs, onlyIncome as QueryIntent)).toEqual([]);
  });

  it("sums only restaurants for the eating-out screenshot", () => {
    const txs = screenshotViews();
    const { answer } = answerFor("How much I spent eating out?", txs);
    expect(answer).toContain("CHIPOTLE: $33.04");
    expect(answer).toContain("KRISPY KREME: $5.61");
    expect(answer).toContain("SHAKE SHACK");
    expect(answer).toContain("MILKSHAKE");
    expect(answer).toContain("SMOOTHIE");
    expect(answer).toContain("BAD DADDY");
    expect(answer).toContain("Total: $377.25");
    expect(answer).not.toContain("DIRECT DEPOSIT");
    expect(answer).not.toContain("NETFLIX");
    expect(answer).not.toContain("LOWE'S FOODS");
    expect(answer).not.toContain("OBGYN");
    expect(answer).not.toContain("ATT PAYMENT");
    expect(answer).not.toContain("RING");
    expect(answer).not.toContain("GOOGLE");
    expect(answer).not.toContain("PAYPAL");
    expect(answer).not.toContain("Amazon Web Services");
    expect(answer).not.toContain("HVAC");
    expect(answer).not.toContain("CUB HOUSE");
    expect(answer).not.toContain("7429.90");
    expect(formatCents(lineTotal(answer))).toBe("$377.25");
    expect(totalCents(selectTransactions(txs, answerFor("How much I spent eating out?", txs).intent))).toBe(37725);
  });

  it("keeps the dining total when a paycheck is called not food", () => {
    const txs = screenshotViews();
    const first = answerFor("How much I spent eating out?", txs);
    const follow = answerFor(
      "This is not a food charge: DIRECT DEPOSIT ELSEVIER INCPAYROLL: $2785.11",
      txs,
      first.intent,
    );
    expect(follow.intent.categories).toEqual(["dining"]);
    expect(follow.intent.excludeMerchants.join(" ")).toContain("DIRECT DEPOSIT");
    expect(follow.answer).toContain("Total: $377.25");
    expect(follow.answer).not.toContain("No matching charges located.");
    expect(follow.answer).not.toContain("DIRECT DEPOSIT");
  });

  it("drops an excluded merchant and keeps the other dining rows", () => {
    const txs = screenshotViews();
    const first = answerFor("How much I spent eating out?", txs);
    const follow = answerFor("exclude chipotle", txs, first.intent);
    expect(follow.answer).not.toContain("CHIPOTLE");
    expect(follow.answer).toContain("KRISPY KREME: $5.61");
    expect(follow.answer).toContain("Total: $287.42");
    expect(formatCents(lineTotal(follow.answer))).toBe("$287.42");
  });

  it("includes gas and coffee and not every restaurant", () => {
    const txs = [
      view("SHELL OIL 12", "-40.00", true),
      view("STARBUCKS STORE 88", "-5.50", true),
      view("CHIPOTLE", "-10.00", true),
      view("PIEDMONT NATURAL GAS", "-30.00", true),
      view("DUNKIN DONUTS", "-4.25", true),
    ];
    const { answer } = answerFor("gas and coffee", txs);
    expect(answer).toContain("SHELL");
    expect(answer).toContain("STARBUCKS");
    expect(answer).toContain("DUNKIN");
    expect(answer).not.toContain("CHIPOTLE");
    expect(answer).not.toContain("Piedmont");
    expect(answer).toContain("Total: $49.75");
    expect(formatCents(lineTotal(answer))).toBe("$49.75");
  });

  it("sums groceries and dining together and honors a date window", () => {
    const txs = [
      { ...view("CHIPOTLE", "-10.00", true), date: "2026-01-05" },
      { ...view("LOWE'S FOODS", "-8.00", true), date: "2026-01-20" },
      { ...view("SHELL OIL 12", "-15.00", true), date: "2026-01-20" },
      { ...view("CHIPOTLE", "-3.00", true), date: "2026-02-02" },
    ];
    const both = answerFor("groceries and dining", txs);
    expect(both.answer).toContain("CHIPOTLE: $10.00");
    expect(both.answer).toContain("CHIPOTLE: $3.00");
    expect(both.answer).toContain("LOWE'S FOODS");
    expect(both.answer).not.toContain("SHELL");
    expect(both.answer).toContain("Total: $21.00");

    const january = answerFor("eating out from 2026-01-01 to 2026-01-31", txs);
    expect(january.answer).toContain("CHIPOTLE: $10.00");
    expect(january.answer).not.toContain("$3.00");
    expect(january.answer).toContain("Total: $10.00");
  });

  it("does not count a paycheck or a refund as the highest charge", () => {
    const txs = [
      view("COSTCO WHSE #123 RALEIGH NC", "-86.20", true),
      view("DIRECT DEPOSIT ELSEVIER INCPAYROLL", "2785.11", true),
      view("AMAZON.COM", "200.00", true),
    ];
    const { answer } = answerFor("What was my highest charge?", txs);
    expect(answer).toContain("Costco");
    expect(answer).toContain("86.20");
    expect(answer).not.toContain("2785.11");
    expect(answer).not.toContain("200.00");
  });

  it("nets a refund against the same spending category", () => {
    const txs = [
      view("AMAZON.COM", "-20.00", true),
      view("AMAZON.COM", "5.00", true),
      view("CHIPOTLE", "-10.00", true),
    ];
    const { answer } = answerFor("shopping", txs);
    expect(answer).toContain("AMAZON.COM: $20.00");
    expect(answer).toContain("AMAZON.COM: -$5.00");
    expect(answer).not.toContain("CHIPOTLE");
    expect(answer).toContain("Total: $15.00");
    expect(formatCents(lineTotal(answer))).toBe("$15.00");
  });

  it("does not let an exclusion of SHELL remove SHELLFISH", () => {
    const shellfish: TxView = {
      ...view("SHELLFISH SHACK", "-30.00", true),
      category: "dining",
      narrative: "SHELLFISH SHACK",
      merchant: "SHELLFISH SHACK",
    };
    const txs = [shellfish, view("CHIPOTLE", "-4.00", true)];
    const first = answerFor("How much I spent eating out?", txs);
    const follow = answerFor("exclude: SHELL", txs, first.intent);
    expect(follow.answer).toContain("SHELLFISH SHACK");
    expect(follow.answer).toContain("CHIPOTLE");
  });

  it("asks the model for intent JSON and not for ledger rows", () => {
    const messages = buildIntentMessages("How much did I spend on hobbies?", null);
    const blob = messages.map((message) => message.content).join("\n");
    expect(blob).toContain("categories");
    expect(blob).toContain("How much did I spend on hobbies?");
    expect(blob).not.toContain("CHIPOTLE");
    expect(blob).toContain("Do not return transaction indexes");
  });
});

describe("ledger migration", () => {
  it("adds category and query intent onto a pre-category table", async () => {
    const stub = env.LEDGER.get(env.LEDGER.idFromName("migration-old"));
    await runInDurableObject(stub, async (_instance, state) => {
      const names = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM schema_migrations")
        .toArray()
        .map((row) => row.name);
      expect(names).toContain(LEDGER_MIGRATION);
      state.storage.sql.exec("DROP TABLE transactions");
      state.storage.sql.exec(
        "CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)",
      );
      state.storage.sql.exec(
        "INSERT INTO transactions (payload) VALUES (?)",
        JSON.stringify({ Description: "CHIPOTLE", Amount: "-1.00" }),
      );
    });
    const migrated = await stub.migrate();
    await stub.migrate();
    expect(migrated.columns).toContain("category");
    const loaded = await stub.load();
    expect(loaded.records[0]?.category).toBeNull();
    expect(loaded.records[0]?.payload.Description).toBe("CHIPOTLE");
    expect(loaded.version).toBe(0);
  });

  it("stores intent per identity and ignores a write for a replaced statement", async () => {
    const ada = env.LEDGER.get(env.LEDGER.idFromName("ada-intent@example.com"));
    const bob = env.LEDGER.get(env.LEDGER.idFromName("bob-intent@example.com"));
    const range = { startDate: "2026-01-01", endDate: "2026-01-01" };
    const first = await ada.replace(
      [{ payload: { Description: "CHIPOTLE", Amount: "-1.00", Date: "2026-01-01" }, category: "dining" }],
      range,
    );
    expect(await ada.saveIntent('{"categories":["dining"],"op":"sum"}', first.version)).toBe(true);
    expect((await ada.loadIntent()).intent).toContain("dining");
    expect((await bob.loadIntent()).intent).toBeNull();
    const next = await ada.replace(
      [{ payload: { Description: "SHELL", Amount: "-2.00", Date: "2026-02-01" }, category: "gas/auto" }],
      { startDate: "2026-02-01", endDate: "2026-02-01" },
    );
    expect(next.version).toBeGreaterThan(first.version);
    expect((await ada.loadIntent()).intent).toBeNull();
    expect(await ada.saveIntent('{"categories":["dining"],"op":"sum"}', first.version)).toBe(false);
    expect((await ada.loadIntent()).intent).toBeNull();
  });
});

function csvOf(rows: Array<[string, string, string]>): string {
  return ["Date,Description,Amount", ...rows.map((row) => row.join(","))].join("\n");
}

async function upload(email: string, csv: string): Promise<Response> {
  const token = await tokenFor(email);
  const form = new FormData();
  form.set("file", new File([csv], "statement.csv", { type: "text/csv" }));
  return authed("/api/upload", token, { method: "POST", body: form });
}

async function query(email: string, question: string): Promise<{ answer?: string }> {
  const token = await tokenFor(email);
  const response = await authed("/api/query", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ answer?: string }>;
}

describe("/api spending queries", () => {
  it("stores categories and answers the screenshot question without a model total", async () => {
    // Cub House matches no rule. A down model must not fail the upload or the total.
    vi.spyOn(env.AI, "run").mockImplementation(async () => {
      throw new Error("model down");
    });
    const email = "shot@example.com";
    const uploaded = await upload(
      email,
      csvOf(screenshotRows.map(([description, amount]) => ["2026-01-15", description, amount])),
    );
    expect(uploaded.status).toBe(200);

    const stub = env.LEDGER.get(env.LEDGER.idFromName(ledgerName(email)));
    const stored = (await stub.load()).records;
    expect(stored.some((row) => row.category === "dining")).toBe(true);
    expect(stored.some((row) => row.category === "income")).toBe(true);
    expect(stored.some((row) => row.category === "groceries")).toBe(true);
    expect(stored.find((row) => row.payload.Description === "LOWE'S FOODS")?.category).toBe(
      "groceries",
    );
    expect(
      stored.find((row) => String(row.payload.Description).includes("CUB HOUSE"))?.category,
    ).toBe("unknown");

    const first = await query(email, "How much I spent eating out?");
    expect(first.answer).toContain("Total: $377.25");
    expect(first.answer).not.toContain("DIRECT DEPOSIT");
    expect(first.answer).not.toContain("7429.90");
    expect(formatCents(lineTotal(first.answer ?? ""))).toBe("$377.25");

    const follow = await query(
      email,
      "This is not a food charge: DIRECT DEPOSIT ELSEVIER INCPAYROLL: $2785.11",
    );
    expect(follow.answer).toContain("Total: $377.25");
    expect(follow.answer).not.toContain("No matching charges located.");
    const saved = await stub.loadIntent();
    expect(saved.intent).toContain("dining");
    expect(saved.intent).toContain("DIRECT DEPOSIT");

    const excluded = await query(email, "exclude chipotle");
    expect(excluded.answer).toContain("Total: $287.42");
    expect(excluded.answer).not.toContain("CHIPOTLE");
  });

  it("does not call Workers AI for a fully ruled statement and question", async () => {
    const run = vi.spyOn(env.AI, "run");
    const email = "ruled@example.com";
    const uploaded = await upload(
      email,
      csvOf([
        ["2026-01-02", "CHIPOTLE", "-12.50"],
        ["2026-01-03", "DIRECT DEPOSIT ACME PAYROLL", "2000.00"],
        ["2026-01-04", "NETFLIX.COM", "-15.49"],
      ]),
    );
    expect(uploaded.status).toBe(200);
    const body = await query(email, "How much I spent eating out?");
    expect(body.answer).toContain("CHIPOTLE: $12.50");
    expect(body.answer).toContain("Total: $12.50");
    expect(body.answer).not.toContain("NETFLIX");
    expect(body.answer).not.toContain("2000.00");
    expect(run).not.toHaveBeenCalled();
  });

  it("uses a mocked Workers AI intent and ignores a row-index reply", async () => {
    const email = "hobby@example.com";
    const uploaded = await upload(
      email,
      csvOf([
        ["2026-01-02", "AMAZON.COM", "-20.00"],
        ["2026-01-03", "CHIPOTLE", "-10.00"],
      ]),
    );
    expect(uploaded.status).toBe(200);

    const run = vi.spyOn(env.AI, "run").mockImplementation(async (_model, input) => {
      const messages =
        (input as { messages?: { content?: string }[] }).messages ?? [];
      const blob = messages.map((message) => message.content ?? "").join("\n");
      expect(blob).not.toContain("AMAZON.COM");
      expect(blob).not.toContain("-20.00");
      expect(blob).toContain("hobbies");
      return {
        response: JSON.stringify({
          categories: ["shopping"],
          merchants: [],
          excludeMerchants: [],
          dateFrom: null,
          dateTo: null,
          op: "sum",
          combine: "or",
        }),
      };
    });

    const hobby = await query(email, "How much did I spend on hobbies?");
    expect(run).toHaveBeenCalled();
    expect(hobby.answer).toContain("20.00");
    expect(hobby.answer).not.toContain("10.00");
    expect(hobby.answer).not.toContain("CHIPOTLE");

    run.mockImplementation(async () => ({ response: '{"indexes":[1,2]}' }));
    const rejected = await query(email, "How much did I spend on widgets?");
    expect(rejected.answer).toBe(
      "I couldn't tell which category or merchant you meant.",
    );
    expect(rejected.answer).not.toContain("20.00");
  });

  it("asks Workers AI only for unknown merchants and keeps that category", async () => {
    const email = "zoop@example.com";
    const run = vi.spyOn(env.AI, "run").mockImplementation(async (_model, input) => {
      const messages =
        (input as { messages?: { content?: string }[] }).messages ?? [];
      const blob = messages.map((message) => message.content ?? "").join("\n");
      expect(blob).toContain("ZOOPLEX SNACKBAR 12");
      expect(blob).not.toContain("-9.50");
      return {
        response: JSON.stringify({
          items: [{ merchant: "ZOOPLEX SNACKBAR 12", category: "dining" }],
        }),
      };
    });
    const uploaded = await upload(
      email,
      csvOf([
        ["2026-01-02", "ZOOPLEX SNACKBAR 12", "-9.50"],
        ["2026-01-03", "CHIPOTLE", "-4.00"],
      ]),
    );
    expect(uploaded.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    const stored = (await env.LEDGER.get(env.LEDGER.idFromName(ledgerName(email))).load())
      .records;
    expect(stored.find((row) => row.payload.Description === "ZOOPLEX SNACKBAR 12")?.category).toBe(
      "dining",
    );
    run.mockClear();
    const body = await query(email, "How much I spent eating out?");
    expect(run).not.toHaveBeenCalled();
    expect(body.answer).toContain("ZOOPLEX");
    expect(body.answer).toContain("CHIPOTLE");
    expect(body.answer).toContain("Total: $13.50");
    expect(formatCents(lineTotal(body.answer ?? ""))).toBe("$13.50");
  });

  it("backfills a legacy row that has no category instead of totaling zero", async () => {
    const email = "legacy@example.com";
    const stub = env.LEDGER.get(env.LEDGER.idFromName(ledgerName(email)));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DROP TABLE IF EXISTS transactions");
      state.storage.sql.exec(
        "CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)",
      );
      state.storage.sql.exec(
        "INSERT INTO transactions (payload) VALUES (?)",
        JSON.stringify({
          Date: "2026-01-02",
          Description: "CHIPOTLE",
          Amount: "-33.04",
        }),
      );
    });
    await stub.migrate();
    await stub.migrate();
    expect((await stub.load()).records[0]?.category).toBeNull();

    const body = await query(email, "How much I spent eating out?");
    expect(body.answer).toContain("CHIPOTLE: $33.04");
    expect(body.answer).toContain("Total: $33.04");
    expect(body.answer).not.toContain("No matching charges located.");
    expect((await stub.load()).records[0]?.category).toBe("dining");
  });

  it("retries an unknown merchant after the model failed", async () => {
    const email = "retry@example.com";
    const run = vi.spyOn(env.AI, "run").mockImplementation(async () => {
      throw new Error("rate limit");
    });
    const uploaded = await upload(
      email,
      csvOf([
        ["2026-01-02", "ZOOPLEX SNACKBAR", "-9.50"],
        ["2026-01-03", "CHIPOTLE", "-4.00"],
      ]),
    );
    expect(uploaded.status).toBe(200);
    const uploadedBody = (await uploaded.json()) as { uncategorized?: number };
    expect(uploadedBody.uncategorized).toBe(1);
    const stub = env.LEDGER.get(env.LEDGER.idFromName(ledgerName(email)));
    expect(
      (await stub.load()).records.find((row) => row.payload.Description === "ZOOPLEX SNACKBAR")
        ?.category,
    ).toBe("unknown");

    const missed = await query(email, "How much I spent eating out?");
    expect(missed.answer).toContain("CHIPOTLE: $4.00");
    expect(missed.answer).not.toContain("ZOOPLEX");
    expect(missed.answer).toContain("still uncategorized");
    expect(
      (await stub.load()).records.find((row) => row.payload.Description === "ZOOPLEX SNACKBAR")
        ?.category,
    ).toBe("unknown");

    run.mockImplementation(async () => ({
      response: JSON.stringify({
        items: [{ merchant: "ZOOPLEX SNACKBAR", category: "dining" }],
      }),
    }));
    const found = await query(email, "How much I spent eating out?");
    expect(found.answer).toContain("ZOOPLEX");
    expect(found.answer).toContain("Total: $13.50");
    expect(
      (await stub.load()).records.find((row) => row.payload.Description === "ZOOPLEX SNACKBAR")
        ?.category,
    ).toBe("dining");
  });

  it("drops the previous question when a new statement is uploaded", async () => {
    const email = "reset@example.com";
    const run = vi.spyOn(env.AI, "run").mockImplementation(async (_model, input) => {
      const messages =
        (input as { messages?: { content?: string }[] }).messages ?? [];
      const blob = messages.map((message) => message.content ?? "").join("\n");
      if (!blob.includes("exclude chipotle")) {
        throw new Error(`unexpected model call: ${blob.slice(0, 120)}`);
      }
      return {
        response: JSON.stringify({
          categories: ["gas/auto"],
          merchants: [],
          excludeMerchants: [],
          dateFrom: null,
          dateTo: null,
          op: "sum",
          combine: "or",
        }),
      };
    });
    const first = await upload(
      email,
      csvOf([
        ["2026-01-02", "CHIPOTLE", "-10.00"],
        ["2026-01-03", "STARBUCKS", "-4.00"],
      ]),
    );
    expect(first.status).toBe(200);
    const eating = await query(email, "How much I spent eating out?");
    expect(eating.answer).toContain("CHIPOTLE");
    const stub = env.LEDGER.get(env.LEDGER.idFromName(ledgerName(email)));
    expect((await stub.loadIntent()).intent).toContain("dining");

    const replaced = await upload(
      email,
      csvOf([
        ["2026-02-01", "SHELL OIL", "-40.00"],
        ["2026-02-02", "STARBUCKS", "-4.00"],
      ]),
    );
    expect(replaced.status).toBe(200);
    expect((await stub.loadIntent()).intent).toBeNull();

    const follow = await query(email, "exclude chipotle");
    expect(run).toHaveBeenCalled();
    expect(follow.answer).toContain("SHELL");
    expect(follow.answer).not.toContain("STARBUCKS");
    expect(follow.answer).not.toContain("CHIPOTLE");
  });

  it("nets a refund on the worker and keeps a deposit out of the highest charge", async () => {
    const email = "refund@example.com";
    const uploaded = await upload(
      email,
      csvOf([
        ["2026-01-02", "AMAZON.COM", "-20.00"],
        ["2026-01-03", "AMAZON.COM", "5.00"],
        ["2026-01-04", "DIRECT DEPOSIT ACME PAYROLL", "900.00"],
        ["2026-01-05", "COSTCO", "-30.00"],
      ]),
    );
    expect(uploaded.status).toBe(200);
    const shopping = await query(email, "shopping");
    expect(shopping.answer).toContain("-$5.00");
    expect(shopping.answer).toContain("Total: $15.00");
    expect(shopping.answer).not.toContain("900.00");
    const highest = await query(email, "What was my highest charge?");
    expect(highest.answer).toContain("Costco");
    expect(highest.answer).toContain("30.00");
    expect(highest.answer).not.toContain("900.00");
    expect(highest.answer).not.toContain("20.00");
  });
});
