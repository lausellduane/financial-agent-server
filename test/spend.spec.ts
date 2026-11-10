import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATEGORY_RULES_VERSION,
  categorizeNarrative,
  parseCategoryAssignments,
} from "../categories.ts";
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
    expect(byDescription.get("PEAK SEASONS HVAC PEAKSEASONSHV NC100126")).toBe(
      "subscriptions",
    );
    expect(categorizeNarrative("LOWES #00677* GARNER", -3800, true)).toBe("home");
    expect(categorizeNarrative("HVAC REPAIR", -20000, true)).toBe("home");
    expect(categorizeNarrative("JOHNSTON COUNTY PUBLIC UTILITIES", -6240, true)).toBe(
      "utilities/telecom",
    );
    expect(categorizeNarrative("JOCO WATER SEWER", -4100, true)).toBe("utilities/telecom");
    expect(categorizeNarrative("CITY WATER DEPT", -3600, true)).toBe("utilities/telecom");
    expect(categorizeNarrative("FIJI WATER", -200, true)).toBe("unknown");
    expect(categorizeNarrative("MR COOPER MORTGAGE PMT", -151000, true)).toBe(
      "housing/mortgage",
    );
    expect(categorizeNarrative("ONLINE PMT HOME LOAN", -151000, true)).toBe(
      "housing/mortgage",
    );
    expect(categorizeNarrative("ACH DEBIT MTG PAYMENT", -151000, true)).toBe(
      "housing/mortgage",
    );
    expect(categorizeNarrative("PLANET HOME", -154142, true)).toBe("unknown");
    expect(categorizeNarrative("PEACOCK TV LLC", -1393, true)).toBe("subscriptions");
    expect(categorizeNarrative("DISNEYPLUS", -1599, true)).toBe("subscriptions");
    expect(categorizeNarrative("DISNEY PLUS", -1599, true)).toBe("subscriptions");
    expect(categorizeNarrative("DISNEY BUNDLE", -1599, true)).toBe("subscriptions");
    expect(categorizeNarrative("HULU", -799, true)).toBe("subscriptions");
    expect(categorizeNarrative("CLOUDFLARE INC", -2000, true)).toBe("subscriptions");
    expect(categorizeNarrative("MICROSOFT*XBOX GAME PASS", -1699, true)).toBe(
      "subscriptions",
    );
    expect(categorizeNarrative("MSBILL.INFO", -1699, true)).toBe("subscriptions");
    expect(categorizeNarrative("X CORP", -800, true)).toBe("subscriptions");
    expect(categorizeNarrative("X.COM", -800, true)).toBe("subscriptions");
    expect(categorizeNarrative("TWITTER", -800, true)).toBe("subscriptions");
    expect(categorizeNarrative("X PREMIUM", -800, true)).toBe("subscriptions");
    expect(categorizeNarrative("EXXON", -4000, true)).toBe("gas/auto");
    expect(categorizeNarrative("MICROSOFT STORE", -5000, true)).toBe("shopping");
    expect(categorizeNarrative("GOOGLE STORE PIXEL 8", -19900, true)).toBe("shopping");
    expect(categorizeNarrative("GOOGLE CLOUD", -3000, true)).toBe("cloud/software");
    const mortgageQuestion = interpretQuestion(
      "How much did I spent in mortgage?",
      null,
      [],
    );
    expect(mortgageQuestion?.confident).toBe(true);
    expect(mortgageQuestion?.intent.categories).toEqual(["housing/mortgage"]);
    const billsQuestion = interpretQuestion("How much did I spent in bills?", null, []);
    expect(billsQuestion?.confident).toBe(true);
    expect(billsQuestion?.intent.categories).toEqual(["utilities/telecom"]);
    expect(categorizeNarrative("BLUE CROSS BLUE SHIELD", -43844, true)).toBe(
      "insurance/health",
    );
    expect(categorizeNarrative("BCBS PREMIUM", -43844, true)).toBe("insurance/health");
    expect(categorizeNarrative("WALGREENS STORE 123", -765, true)).toBe("healthcare");
    expect(categorizeNarrative("CARY OBGYN 919-4675941", -5000, true)).toBe("healthcare");
    expect(categorizeNarrative("CVS/PHARMACY", -500, true)).toBe("healthcare");
    expect(categorizeNarrative("GEICO AUTO", -9000, true)).toBe("insurance/auto");
    expect(categorizeNarrative("PROGRESSIVE INSURANCE", -11000, true)).toBe(
      "insurance/auto",
    );
    expect(categorizeNarrative("PROGRESSIVE LEASING", -4000, true)).toBe("unknown");
    expect(categorizeNarrative("STATE FARM", -12000, true)).toBe("insurance/auto");
    const healthInsurance = interpretQuestion("How much did I spent in insurance?", null, []);
    expect(healthInsurance?.confident).toBe(true);
    expect(healthInsurance?.intent.categories).toEqual(["insurance/health"]);
    const carInsurance = interpretQuestion(
      "How about car insurance?",
      healthInsurance?.intent ?? null,
      [],
    );
    expect(carInsurance?.followUp).toBe(false);
    expect(carInsurance?.intent.categories).toEqual(["insurance/auto"]);
    expect(formatAnswer([], carInsurance!.intent)).toBe(
      "No car insurance charges were found.",
    );
    expect(categorizeNarrative("WELLS FARGO BANK MORTGAGE", -150000, true)).toBe(
      "housing/mortgage",
    );
    expect(categorizeNarrative("NAVY FCU MTG PAYMENT", -90000, true)).toBe(
      "housing/mortgage",
    );
    expect(categorizeNarrative("SHELL FEDERAL CREDIT UNION", -7500, true)).toBe("transfers");
    expect(categorizeNarrative("MTG ARENA", -2000, true)).toBe("unknown");
    expect(categorizeNarrative("LOTTERY TICKETS", -1000, true)).toBe("unknown");
    expect(categorizeNarrative("FOUR SEASONS HVAC", -20000, true)).toBe("home");
    expect(categorizeNarrative("KANSAS CITY WATER STREET", -1500, true)).toBe("unknown");
    expect(categorizeNarrative("CITY WATER DEPT", -3600, true)).toBe("utilities/telecom");
    expect(categorizeNarrative("MICROSOFT*STORE", -5000, true)).toBe("shopping");
    expect(categorizeNarrative("MSBILL.INFO XBOX", -1699, true)).toBe("subscriptions");
    expect(categorizeNarrative("SQ *SHAKE SHACK MEMBER NIGHT", -1200, true)).toBe("dining");
    const diningAndBills = interpretQuestion("dining and bills", null, []);
    expect(diningAndBills?.intent.categories).toEqual(["dining", "utilities/telecom"]);
    expect(
      intentFromModel(
        JSON.stringify({ categories: ["dining", "home"], op: "sum" }),
        "dining and bills",
      )?.categories,
    ).toEqual(["dining", "utilities/telecom"]);
    expect(
      interpretQuestion("How about car insurance?", diningAndBills?.intent ?? null, [])
        ?.intent.categories,
    ).toEqual(["insurance/auto"]);
    expect(
      intentFromModel(
        JSON.stringify({ categories: ["home"], op: "sum" }),
        "How much did I spent in mortgage?",
      )?.categories,
    ).toEqual(["housing/mortgage"]);
    expect(
      intentFromModel(
        JSON.stringify({ categories: ["home", "utilities/telecom"], op: "sum" }),
        "How much did I spent in bills?",
      )?.categories,
    ).toEqual(["utilities/telecom"]);
    expect(byDescription.get("SQ *THE CUB HOUSE PLAY GOSQ.COM")).toBe("subscriptions");
    expect(categorizeNarrative("DOLLAR TREE GARNER", -396, true)).toBe("shopping");
    expect(categorizeNarrative("DOLLAR GENERAL #4412", -500, true)).toBe("shopping");
    expect(categorizeNarrative("FAMILY DOLLAR", -300, true)).toBe("shopping");
    expect(categorizeNarrative("DOA FAIR ETIX TICKETS RALEIGH", -2620, true)).toBe(
      "entertainment/events",
    );
    expect(categorizeNarrative("TICKETMASTER", -8000, true)).toBe("entertainment/events");
    expect(categorizeNarrative("STUBHUB TICKETS", -4500, true)).toBe("entertainment/events");
    expect(categorizeNarrative("PARKING TICKET", -2500, true)).toBe("unknown");
    expect(categorizeNarrative("SQ *PLANET PLAY MEMBERSHIP", -1999, true)).toBe(
      "subscriptions",
    );
    expect(categorizeNarrative("PIEDMONT NATURAL GAS", -4000, true)).toBe(
      "utilities/telecom",
    );
    expect(categorizeNarrative("SHELL OIL 12", -4000, true)).toBe("gas/auto");
    expect(categorizeNarrative("MOBILE DEPOSIT", 250000, true)).toBe("income");
    expect(categorizeNarrative("MOBILE DEPOSIT", 250000, false)).toBe("income");
    expect(categorizeNarrative("SHELLFISH SHACK", -3000, true)).toBe("unknown");
    expect(categorizeNarrative("SONICARE TOOTHBRUSH", -8000, true)).toBe("unknown");
    expect(categorizeNarrative("SONIC DRIVE IN", -500, true)).toBe("dining");
    expect(categorizeNarrative("MOBIL OIL", -4000, true)).toBe("gas/auto");
    expect(categorizeNarrative("COSTCO GAS", -4500, true)).toBe("gas/auto");
    expect(categorizeNarrative("COSTCO GASOLINE", -2500, true)).toBe("gas/auto");
    expect(categorizeNarrative("COSTCO WHSE", -8000, true)).toBe("groceries");
    expect(categorizeNarrative("SHELL FEDERAL CREDIT UNION DEPOSIT", 250000, true)).toBe(
      "income",
    );
    expect(categorizeNarrative("SHELL FEDERAL CREDIT UNION", 250000, true)).toBe("income");
    expect(categorizeNarrative("SHELL OIL", 500, true)).toBe("gas/auto");
    expect(categorizeNarrative("CITY GAS BILL", -8000, true)).toBe("utilities/telecom");
    expect(categorizeNarrative("PIEDMONT NATURAL GAS", -4000, true)).toBe(
      "utilities/telecom",
    );
    expect(categorizeNarrative("pending", -5000, true)).toBe("other");
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
    expect(onlyIncome?.categories).toEqual(["dining"]);
    const txs = screenshotViews();
    const picked = selectTransactions(txs, onlyIncome as QueryIntent);
    expect(picked.some((tx) => tx.narrative.includes("CHIPOTLE"))).toBe(true);
    expect(picked.some((tx) => tx.narrative.includes("PAYROLL"))).toBe(false);
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

  it("does not treat shellfish as the shell station when excluding", () => {
    const shell = view("SHELL OIL", "-15.00", true);
    const fish = {
      ...view("SHELLFISH SHACK", "-30.00", true),
      category: "dining" as const,
      narrative: "SHELLFISH SHACK",
      merchant: "SHELLFISH SHACK",
    };
    const first = answerFor("How much did I spend?", [shell, fish]);
    const follow = answerFor("exclude shellfish", [shell, fish], first.intent);
    expect(follow.answer).toContain("SHELL");
    expect(follow.answer).toContain("15.00");
    expect(follow.answer).not.toContain("SHELLFISH");
    expect(follow.answer).not.toContain("30.00");
  });

  it("rejects a reversed date range instead of sorting it", () => {
    const parsed = interpretQuestion(
      "eating out from 2026-02-01 to 2026-01-01",
      null,
      [],
    );
    expect(parsed?.invalidDateRange).toBe(true);
    expect(parsed?.invalidCalendarDate).toBe(false);
  });

  it("rejects an ISO token that is not a real calendar day", () => {
    for (const question of [
      "eating out on 2026-02-31",
      "eating out from 2026-02-31 to 2026-03-04",
      "eating out from 2026-03-01 to 2026-02-31",
      "eating out on 2025-02-29",
      "eating out on 2026-13-01",
    ]) {
      const parsed = interpretQuestion(question, null, []);
      expect(parsed?.invalidCalendarDate).toBe(true);
      expect(parsed?.intent.dateFrom).toBeNull();
    }
    const leap = interpretQuestion("eating out on 2024-02-29", null, []);
    expect(leap?.invalidCalendarDate).toBe(false);
    expect(leap?.intent.dateFrom).toBe("2024-02-29");
    expect(leap?.intent.dateTo).toBe("2024-02-29");
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
  const result = await queryRaw(email, question);
  expect(result.status).toBe(200);
  return result.body;
}

async function expectConflict(response: Response, absent: string): Promise<void> {
  expect(response.status).toBe(409);
  try {
    const body = (await response.json()) as { error?: string; answer?: string };
    expect(body.error).toMatch(/statement changed/i);
    expect(body.error).toMatch(/Ask again/);
    expect(body.answer).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(absent);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Replacing the statement is I/O in another context, so workerd will not
    // hand this body to the test. Require that refusal, then drop the stream.
    expect(message).toMatch(/different request/);
  }
  await response.body?.cancel().catch(() => undefined);
}

async function replaceDuringQuery(email: string): Promise<void> {
  // A second HTTP call while this response is open makes workerd refuse the
  // body, and the unread stream then stalls the rest of the isolate. The
  // ledger write is the same version bump the upload route persists.
  const stub = env.LEDGER.get(env.LEDGER.idFromName(ledgerName(email)));
  await stub.replace(
    [
      {
        payload: { Date: "2026-02-01", Description: "SHELL OIL", Amount: "-40.00" },
        category: "gas/auto",
      },
    ],
    { startDate: "2026-02-01", endDate: "2026-02-01" },
  );
}

async function queryRaw(
  email: string,
  question: string,
): Promise<{ status: number; body: { answer?: string; error?: string } }> {
  const token = await tokenFor(email);
  const response = await authed("/api/query", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { answer?: string; error?: string },
  };
}

describe("/api spending queries", () => {
  it("stores categories and answers the screenshot question without a model total", async () => {
    // Cub House is a Square membership, so a down model does not leave it unknown.
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
    ).toBe("subscriptions");

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
    expect(missed.answer).toContain("1 uncategorized charge ($9.50)");
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

  it("does not count a mobile deposit as gas or as the highest charge", async () => {
    const email = "deposit@example.com";
    const uploaded = await upload(
      email,
      csvOf([
        ["2026-01-02", "SHELL OIL", "-40.00"],
        ["2026-01-03", "MOBILE DEPOSIT", "2500.00"],
        ["2026-01-04", "CHIPOTLE", "-10.00"],
      ]),
    );
    expect(uploaded.status).toBe(200);
    const gas = await query(email, "gas");
    expect(gas.answer).toContain("Total: $40.00");
    expect(gas.answer).not.toContain("2500");
    expect(gas.answer).not.toContain("2460");
    expect(gas.answer).not.toContain("CHIPOTLE");

    const positive = await upload(
      email,
      csvOf([
        ["2026-01-02", "COSTCO", "30.00"],
        ["2026-01-03", "MOBILE DEPOSIT", "2500.00"],
      ]),
    );
    expect(positive.status).toBe(200);
    const highest = await query(email, "What was my highest charge?");
    expect(highest.answer).toContain("Costco");
    expect(highest.answer).toContain("30.00");
    expect(highest.answer).not.toContain("2500");
  });

  it("names zero-amount rows and keeps nonzero blank or pending charges", async () => {
    const email = "omitted@example.com";
    const uploaded = await upload(
      email,
      csvOf([
        ["2026-01-01", "CHIPOTLE", "-10.00"],
        ["2026-01-02", "pending", "-50.00"],
        ["2026-01-03", "", "-25.00"],
        ["2026-01-04", "CHIPOTLE", "0"],
      ]),
    );
    expect(uploaded.status).toBe(200);
    expect((await uploaded.json()) as { count?: number }).toMatchObject({ count: 4 });
    const body = await query(email, "How much did I spend?");
    expect(body.answer).toContain("10.00");
    expect(body.answer).toContain("50.00");
    expect(body.answer).toContain("25.00");
    expect(body.answer).toContain("Total: $85.00");
    expect(body.answer).toContain("1 zero-amount row");
  });

  it("keeps Costco Gas out of groceries", async () => {
    const email = "costco-gas@example.com";
    expect(
      (
        await upload(
          email,
          csvOf([
            ["2026-01-02", "COSTCO GAS", "-45.00"],
            ["2026-01-03", "COSTCO WHSE", "-80.00"],
          ]),
        )
      ).status,
    ).toBe(200);
    const gas = await query(email, "gas");
    expect(gas.answer).toContain("45.00");
    expect(gas.answer).not.toContain("80.00");
    const groceries = await query(email, "groceries");
    expect(groceries.answer).toContain("80.00");
    expect(groceries.answer).not.toContain("45.00");
  });

  it("does not drop a shell charge when the question says shellfish", async () => {
    const email = "shellfish@example.com";
    vi.spyOn(env.AI, "run").mockImplementation(async () => ({
      response: JSON.stringify({
        items: [{ merchant: "SHELLFISH SHACK", category: "dining" }],
      }),
    }));
    expect(
      (
        await upload(
          email,
          csvOf([
            ["2026-01-02", "SHELL OIL", "-15.00"],
            ["2026-01-03", "SHELLFISH SHACK", "-30.00"],
          ]),
        )
      ).status,
    ).toBe(200);
    const spent = await query(email, "How much did I spend?");
    expect(spent.answer).toContain("15.00");
    expect(spent.answer).toContain("30.00");
    const follow = await query(email, "exclude shellfish");
    expect(follow.answer).toContain("15.00");
    expect(follow.answer).not.toContain("30.00");
    expect(follow.answer).not.toContain("SHELLFISH");
  });

  it("rejects a reversed date range on the worker", async () => {
    const email = "dates@example.com";
    expect(
      (
        await upload(
          email,
          csvOf([
            ["2026-01-15", "CHIPOTLE", "-10.00"],
            ["2026-02-15", "CHIPOTLE", "-30.00"],
          ]),
        )
      ).status,
    ).toBe(200);
    const result = await queryRaw(email, "eating out from 2026-02-01 to 2026-01-01");
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/start date is after the end date/);
    expect(result.body.answer).toBeUndefined();
  });

  it("returns 409 instead of the replaced statement after a held model call", async () => {
    const email = "race-intent@example.com";
    expect(
      (await upload(email, csvOf([["2026-01-02", "AMAZON.COM", "-20.00"]]))).status,
    ).toBe(200);
    let release!: (value?: unknown) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    vi.spyOn(env.AI, "run").mockImplementation(async () => {
      markEntered();
      await gate;
      await replaceDuringQuery(email);
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
    const token = await tokenFor(email);
    const pending = authed("/api/query", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "How much did I spend on hobbies?" }),
    });
    await entered;
    release();
    const response = await pending;
    await expectConflict(response, "20.00");
    const current = await query(email, "How much did I spend?");
    expect(current.answer).toContain("40.00");
    expect(current.answer).not.toContain("20.00");
  });

  it("returns 409 when the held model call fails after replacement", async () => {
    const email = "race-error@example.com";
    expect(
      (await upload(email, csvOf([["2026-01-02", "AMAZON.COM", "-20.00"]]))).status,
    ).toBe(200);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    vi.spyOn(env.AI, "run").mockImplementation(async () => {
      markEntered();
      await gate;
      await replaceDuringQuery(email);
      throw new Error("model down");
    });
    const token = await tokenFor(email);
    const pending = authed("/api/query", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "How much did I spend on hobbies?" }),
    });
    await entered;
    release();
    const response = await pending;
    await expectConflict(response, "20.00");
    const current = await query(email, "How much did I spend?");
    expect(current.answer).toContain("40.00");
    expect(current.answer).not.toContain("20.00");
  });

  it("returns 409 when categorization is released onto a replaced statement", async () => {
    const email = "race-category@example.com";
    vi.spyOn(env.AI, "run").mockImplementation(async () => {
      throw new Error("rate limit");
    });
    const initial = await upload(
      email,
      csvOf([["2026-01-02", "ZOOPLEX SNACKBAR", "-9.50"]]),
    );
    expect(initial.status).toBe(200);
    await initial.arrayBuffer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    vi.spyOn(env.AI, "run").mockImplementation(async () => {
      markEntered();
      await gate;
      await replaceDuringQuery(email);
      return {
        response: JSON.stringify({
          items: [{ merchant: "ZOOPLEX SNACKBAR", category: "dining" }],
        }),
      };
    });
    const token = await tokenFor(email);
    const pending = authed("/api/query", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "How much did I spend?" }),
    });
    await entered;
    release();
    const response = await pending;
    await expectConflict(response, "9.50");
    const current = await query(email, "How much did I spend?");
    expect(current.answer).toContain("40.00");
    expect(current.answer).not.toContain("9.50");
  });

  it("does not treat a credit-union credit as fuel", async () => {
    const email = "credit-union@example.com";
    for (const description of [
      "SHELL FEDERAL CREDIT UNION DEPOSIT",
      "SHELL FEDERAL CREDIT UNION",
    ]) {
      expect(
        (
          await upload(
            email,
            csvOf([
              ["2026-01-02", "SHELL OIL", "-40.00"],
              ["2026-01-03", description, "2500.00"],
              ["2026-01-04", "CHIPOTLE", "-10.00"],
            ]),
          )
        ).status,
      ).toBe(200);
      const gas = await query(email, "gas");
      expect(gas.answer).toContain("Total: $40.00");
      expect(gas.answer).not.toContain("2460");
      expect(gas.answer).not.toContain("2500");
      const spent = await query(email, "How much did I spend?");
      expect(spent.answer).toContain("Total: $50.00");
      expect(spent.answer).not.toContain("2450");
      expect(spent.answer).not.toContain("2500");
      const highest = await query(email, "What was my highest charge?");
      expect(highest.answer).toContain("40.00");
      expect(highest.answer).not.toContain("2500");
    }
  });

  it("keeps a city gas bill out of vehicle fuel and in the overall total", async () => {
    const email = "city-gas@example.com";
    expect(
      (
        await upload(
          email,
          csvOf([
            ["2026-01-02", "CITY GAS BILL", "-80.00"],
            ["2026-01-03", "SHELL OIL", "-40.00"],
            ["2026-01-04", "CHIPOTLE", "-10.00"],
          ]),
        )
      ).status,
    ).toBe(200);
    const narrowGas = await query(email, "gas");
    expect(narrowGas.answer).toContain("Total: $40.00");
    expect(narrowGas.answer).not.toContain("80.00");
    const narrowSpent = await query(email, "How much did I spend?");
    expect(narrowSpent.answer).toContain("Total: $130.00");
    const narrowHighest = await query(email, "What was my highest charge?");
    expect(narrowHighest.answer).toContain("80.00");

    expect(
      (
        await upload(
          email,
          csvOf([
            ["2026-01-02", "CITY GAS BILL", "-80.00"],
            ["2026-01-03", "SHELL OIL", "-40.00"],
            ["2026-01-04", "CHIPOTLE", "-10.00"],
            ["2026-01-05", "COSTCO GASOLINE", "-25.00"],
            ["2026-01-06", "COSTCO WHSE", "-15.00"],
          ]),
        )
      ).status,
    ).toBe(200);
    const gas = await query(email, "gas");
    expect(gas.answer).toContain("40.00");
    expect(gas.answer).toContain("25.00");
    expect(gas.answer).not.toContain("80.00");
    expect(gas.answer).not.toContain("15.00");
    expect(gas.answer).toContain("Total: $65.00");
    const groceries = await query(email, "groceries");
    expect(groceries.answer).toContain("15.00");
    expect(groceries.answer).not.toContain("25.00");
    const spent = await query(email, "How much did I spend?");
    expect(spent.answer).toContain("Total: $170.00");
    const highest = await query(email, "What was my highest charge?");
    expect(highest.answer).toContain("80.00");
  });

  it("keeps the merchant name on a pending charge", async () => {
    const email = "chipotle-pending@example.com";
    expect(
      (
        await upload(
          email,
          csvOf([
            ["2026-01-01", "CHIPOTLE PENDING", "-12.00"],
            ["2026-01-02", "pending", "-50.00"],
            ["2026-01-03", "CHIPOTLE", "0"],
          ]),
        )
      ).status,
    ).toBe(200);
    const spent = await query(email, "How much did I spend?");
    expect(spent.answer).toContain("CHIPOTLE PENDING");
    expect(spent.answer).toContain("12.00");
    expect(spent.answer).toContain("Pending");
    expect(spent.answer).toContain("50.00");
    expect(spent.answer).toContain("Total: $62.00");
    expect(spent.answer).toContain("1 zero-amount row");
  });

  it("rejects an explicit ISO date that is not a real day", async () => {
    const email = "bad-date@example.com";
    expect(
      (
        await upload(
          email,
          csvOf([
            ["2026-01-15", "CHIPOTLE", "-100.00"],
            ["2026-02-10", "CHIPOTLE", "-7.11"],
            ["2026-03-01", "CHIPOTLE", "-1.00"],
            ["2026-03-04", "CHIPOTLE", "-5.35"],
            ["2024-02-29", "CHIPOTLE", "-3.00"],
          ]),
        )
      ).status,
    ).toBe(200);
    const run = vi.spyOn(env.AI, "run").mockImplementation(async () => {
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
      const result = await queryRaw(email, question);
      expect(result.status, question).toBe(400);
      expect(result.body.error).toMatch(/not a valid calendar date/);
      expect(result.body.answer).toBeUndefined();
    }
    const reversed = await queryRaw(email, "eating out from 2026-03-04 to 2026-03-01");
    expect(reversed.status).toBe(400);
    expect(reversed.body.error).toMatch(/start date is after the end date/);
    expect(run).not.toHaveBeenCalled();

    const exact = await query(email, "eating out on 2026-03-04");
    expect(exact.answer).toContain("Total: $5.35");
    expect(exact.answer).not.toContain("100.00");
    const range = await query(email, "eating out from 2026-03-01 to 2026-03-04");
    expect(range.answer).toContain("Total: $6.35");
    expect(range.answer).not.toContain("100.00");
    const leap = await query(email, "eating out on 2024-02-29");
    expect(leap.answer).toContain("Total: $3.00");
    expect(leap.answer).not.toContain("100.00");
    const open = await query(email, "eating out");
    expect(open.answer).toContain("100.00");
    expect(open.answer).toContain("5.35");
  });

  it("rejects an invalid date before categorizing an unknown merchant", async () => {
    const email = "bad-date-unknown@example.com";
    const run = vi.spyOn(env.AI, "run").mockImplementation(async () => {
      throw new Error("upload categorization fails");
    });
    const uploaded = await upload(
      email,
      csvOf([
        ["2026-01-15", "CHIPOTLE", "-10.00"],
        ["2026-03-04", "ZOOPLEX SNACKBAR", "-5.35"],
      ]),
    );
    expect(uploaded.status).toBe(200);
    expect(run).toHaveBeenCalled();
    const stub = env.LEDGER.get(env.LEDGER.idFromName(ledgerName(email)));
    const categoryOf = async (description: string) =>
      (await stub.load()).records.find((row) => row.payload.Description === description)?.category;
    expect(await categoryOf("ZOOPLEX SNACKBAR")).toBe("unknown");
    expect(await categoryOf("CHIPOTLE")).toBe("dining");
    run.mockClear();
    run.mockImplementation(async () => ({
      response: JSON.stringify({
        items: [{ merchant: "ZOOPLEX SNACKBAR", category: "dining" }],
      }),
    }));
    for (const question of [
      "eating out on 2026-02-31",
      "eating out from 2026-02-31 to 2026-03-04",
      "eating out on 2025-02-29",
    ]) {
      const result = await queryRaw(email, question);
      expect(result.status, question).toBe(400);
      expect(result.body.error).toMatch(/not a valid calendar date/);
      expect(result.body.answer).toBeUndefined();
    }
    const reversed = await queryRaw(email, "eating out from 2026-03-04 to 2026-03-01");
    expect(reversed.status).toBe(400);
    expect(reversed.body.error).toMatch(/start date is after the end date/);
    expect(run).not.toHaveBeenCalled();
    expect(await categoryOf("ZOOPLEX SNACKBAR")).toBe("unknown");
    expect(await categoryOf("CHIPOTLE")).toBe("dining");

    const exact = await query(email, "eating out on 2026-03-04");
    expect(run).toHaveBeenCalled();
    expect(exact.answer).toContain("ZOOPLEX");
    expect(exact.answer).toContain("5.35");
    expect(exact.answer).not.toContain("10.00");
    expect(await categoryOf("ZOOPLEX SNACKBAR")).toBe("dining");
  });

  it("rejects an invalid date before backfilling a legacy null category", async () => {
    const email = "bad-date-legacy@example.com";
    const stub = env.LEDGER.get(env.LEDGER.idFromName(ledgerName(email)));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DROP TABLE IF EXISTS transactions");
      state.storage.sql.exec(
        "CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)",
      );
      for (const row of [
        { Date: "2026-03-04", Description: "ZOOPLEX SNACKBAR", Amount: "-5.35" },
        { Date: "2026-01-15", Description: "CHIPOTLE", Amount: "-10.00" },
      ]) {
        state.storage.sql.exec("INSERT INTO transactions (payload) VALUES (?)", JSON.stringify(row));
      }
    });
    await stub.migrate();
    expect((await stub.load()).records.every((row) => row.category === null)).toBe(true);
    const run = vi.spyOn(env.AI, "run").mockImplementation(async () => ({
      response: JSON.stringify({
        items: [{ merchant: "ZOOPLEX SNACKBAR", category: "dining" }],
      }),
    }));
    const result = await queryRaw(email, "eating out on 2026-02-31");
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/not a valid calendar date/);
    expect(run).not.toHaveBeenCalled();
    const held = await stub.load();
    expect(held.records.find((row) => row.payload.Description === "ZOOPLEX SNACKBAR")?.category).toBe(
      null,
    );
    expect(held.records.find((row) => row.payload.Description === "CHIPOTLE")?.category).toBe(null);

    const exact = await query(email, "eating out on 2026-03-04");
    expect(run).toHaveBeenCalled();
    expect(exact.answer).toContain("5.35");
    expect(exact.answer).not.toContain("10.00");
    const filled = await stub.load();
    expect(filled.records.find((row) => row.payload.Description === "ZOOPLEX SNACKBAR")?.category).toBe(
      "dining",
    );
    expect(filled.records.find((row) => row.payload.Description === "CHIPOTLE")?.category).toBe(
      "dining",
    );
  });

  it("keeps stores, tickets, memberships, bills, and the mortgage payment apart", async () => {
    const email = "categories@example.com";
    const run = vi.spyOn(env.AI, "run").mockImplementation(async () => {
      throw new Error("rules cover these merchants");
    });
    const rows: Array<[string, string, string]> = [
      ["2026-10-02", "CHIPOTLE", "-10.00"],
      ["2026-10-03", "SQ *SHAKE SHACK RALEIGH", "-8.00"],
      ["2026-10-04", "DOLLAR TREE GARNER", "-4.00"],
      ["2026-10-05", "DOA FAIR ETIX TICKETS RALEIGH", "-26.20"],
      ["2026-10-06", "SQ *THE CUB HOUSE PLAY GOSQ.COM", "-23.99"],
      ["2026-10-07", "LOWE'S", "-17.06"],
      ["2026-10-08", "LOWES #00677* GARNER", "-38.00"],
      ["2026-10-09", "PEAK SEASONS HVAC PEAKSEASONSHV NC100126", "-17.16"],
      ["2026-10-10", "DUKE ENERGY", "-227.32"],
      ["2026-10-11", "ATT PAYMENT", "-100.67"],
      ["2026-10-12", "PIEDMONT NATURAL GAS", "-49.86"],
      ["2026-10-13", "JOHNSTON COUNTY PUBLIC UTILITIES", "-62.40"],
      ["2026-10-14", "CITY GAS BILL", "-80.00"],
      ["2026-10-15", "MR COOPER MORTGAGE PMT", "-1510.00"],
      ["2026-10-16", "SHELL OIL", "-40.00"],
    ];
    expect((await upload(email, csvOf(rows))).status).toBe(200);
    expect(run).not.toHaveBeenCalled();
    const stub = env.LEDGER.get(env.LEDGER.idFromName(ledgerName(email)));
    await stub.replace(
      rows.map(([date, description, amount]) => ({
        payload: { Date: date, Description: description, Amount: amount },
        category: description.includes("CHIPOTLE") ? "dining" : "home",
      })),
      { startDate: "2026-10-02", endDate: "2026-10-16" },
    );

    const eating = await query(email, "How much did I spent eating out?");
    expect(run).not.toHaveBeenCalled();
    expect(eating.answer).toContain("CHIPOTLE");
    expect(eating.answer).toContain("SHAKE SHACK");
    expect(eating.answer).toContain("Total: $18.00");
    expect(eating.answer).not.toContain("DOLLAR TREE");
    expect(eating.answer).not.toContain("ETIX");
    expect(eating.answer).not.toContain("CUB HOUSE");

    const shopping = await query(email, "How much did I spend on general merchandise?");
    expect(shopping.answer).toContain("DOLLAR TREE");
    expect(shopping.answer).toContain("Total: $4.00");
    expect(shopping.answer).not.toContain("CHIPOTLE");
    const tickets = await query(email, "How much did I spend on tickets?");
    expect(tickets.answer).toContain("ETIX");
    expect(tickets.answer).toContain("Total: $26.20");
    const subs = await query(email, "subscriptions");
    expect(subs.answer).toContain("CUB HOUSE");
    expect(subs.answer).toContain("PEAK SEASONS");
    expect(subs.answer).toContain("Total: $41.15");
    expect(subs.answer).not.toContain("LOWE");
    expect(subs.answer).not.toContain("SHAKE SHACK");

    const bills = await query(email, "How much did I spent in bills?");
    expect(bills.answer).toContain("Duke Energy");
    expect(bills.answer).toContain("ATT");
    expect(bills.answer).toContain("Piedmont");
    expect(bills.answer).toContain("JOHNSTON");
    expect(bills.answer).toContain("CITY GAS BILL");
    expect(bills.answer).toContain("Total: $520.25");
    expect(bills.answer).not.toContain("LOWE");
    expect(bills.answer).not.toContain("PEAK SEASONS");
    expect(bills.answer).not.toContain("17.06");
    expect(bills.answer).not.toContain("38.00");
    expect(bills.answer).not.toContain("17.16");
    expect(bills.answer).not.toContain("SHELL OIL");

    const mortgage = await query(email, "How much did I spent in mortgage?");
    expect(mortgage.answer).toContain("MR COOPER");
    expect(mortgage.answer).toContain("Total: $1510.00");
    expect(mortgage.answer).not.toContain("LOWE");
    expect(mortgage.answer).not.toContain("PEAK SEASONS");
    expect(mortgage.answer).not.toContain("72.22");
    expect(run).not.toHaveBeenCalled();

    const stored = await stub.load();
    const categoryOf = (description: string) =>
      stored.records.find((row) => row.payload.Description === description)?.category;
    expect(categoryOf("DOLLAR TREE GARNER")).toBe("shopping");
    expect(categoryOf("DOA FAIR ETIX TICKETS RALEIGH")).toBe("entertainment/events");
    expect(categoryOf("SQ *THE CUB HOUSE PLAY GOSQ.COM")).toBe("subscriptions");
    expect(categoryOf("SQ *SHAKE SHACK RALEIGH")).toBe("dining");
    expect(categoryOf("LOWE'S")).toBe("home");
    expect(categoryOf("LOWES #00677* GARNER")).toBe("home");
    expect(categoryOf("PEAK SEASONS HVAC PEAKSEASONSHV NC100126")).toBe("subscriptions");
    expect(categoryOf("JOHNSTON COUNTY PUBLIC UTILITIES")).toBe("utilities/telecom");
    expect(categoryOf("CITY GAS BILL")).toBe("utilities/telecom");
    expect(categoryOf("MR COOPER MORTGAGE PMT")).toBe("housing/mortgage");
    expect(categoryOf("SHELL OIL")).toBe("gas/auto");
  });

  it("includes the subscription descriptors and leaves store purchases out", async () => {
    const email = "subs@example.com";
    const run = vi.spyOn(env.AI, "run").mockImplementation(async () => {
      throw new Error("rules cover these merchants");
    });
    expect(
      (
        await upload(
          email,
          csvOf([
            ["2026-10-01", "PEACOCK TV LLC", "-13.93"],
            ["2026-10-02", "NETFLIX.COM NETFLIX.COM", "-21.44"],
            ["2026-10-03", "RING SOLO PLAN RING.COM", "-4.99"],
            ["2026-10-04", "GOOGLE*G1SK003M 650-2530000", "-9.99"],
            ["2026-10-05", "DISNEYPLUS HULU BUNDLE", "-15.99"],
            ["2026-10-06", "CLOUDFLARE", "-20.00"],
            ["2026-10-07", "MICROSOFT*XBOX GAME PASS", "-16.99"],
            ["2026-10-08", "X CORP", "-8.00"],
            ["2026-10-09", "SQ *THE CUB HOUSE PLAY GOSQ.COM", "-23.99"],
            ["2026-10-10", "PEAK SEASONS HVAC PEAKSEASONSHV NC100126", "-17.16"],
            ["2026-10-11", "MICROSOFT STORE", "-50.00"],
            ["2026-10-12", "GOOGLE *PIXEL 8", "-199.00"],
            ["2026-10-13", "CHIPOTLE", "-10.00"],
          ]),
        )
      ).status,
    ).toBe(200);
    expect(run).not.toHaveBeenCalled();
    const subs = await query(email, "How much did I spent in subscriptions?");
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
      expect(subs.answer).toContain(name);
    }
    expect(subs.answer).toContain("Total: $152.48");
    expect(subs.answer).not.toContain("MICROSOFT STORE");
    expect(subs.answer).not.toContain("PIXEL");
    expect(subs.answer).not.toContain("CHIPOTLE");
    const shopping = await query(email, "shopping");
    expect(shopping.answer).toContain("MICROSOFT STORE");
    expect(shopping.answer).toContain("PIXEL");
    expect(shopping.answer).not.toContain("NETFLIX");
    expect(shopping.answer).not.toContain("XBOX");
  });

  it("keeps insurance, medical care, and a car-insurance follow-up apart", async () => {
    const email = "insurance@example.com";
    const run = vi.spyOn(env.AI, "run").mockImplementation(async () => {
      throw new Error("rules cover these merchants");
    });
    const rows: Array<[string, string, string]> = [
      ["2026-10-01", "CARY OBGYN 919-4675941", "-50.00"],
      ["2026-10-02", "WALGREENS", "-7.65"],
      ["2026-10-03", "WALGREENS STORE", "-7.71"],
      ["2026-10-04", "WALGREENS STORE", "-2.03"],
      ["2026-10-05", "BLUE CROSS BLUE SHIELD", "-438.44"],
      ["2026-10-06", "LOWE'S", "-17.06"],
      ["2026-10-07", "LOWES #00677* GARNER", "-38.00"],
      ["2026-10-08", "PEAK SEASONS HVAC PEAKSEASONSHV NC100126", "-17.16"],
    ];
    expect((await upload(email, csvOf(rows))).status).toBe(200);
    expect(run).not.toHaveBeenCalled();
    const stub = env.LEDGER.get(env.LEDGER.idFromName(ledgerName(email)));
    await stub.replace(
      rows.map(([date, description, amount]) => ({
        payload: { Date: date, Description: description, Amount: amount },
        category: "healthcare",
      })),
      { startDate: "2026-10-01", endDate: "2026-10-08" },
    );

    const insurance = await query(email, "How much did I spent in insurance?");
    expect(run).not.toHaveBeenCalled();
    expect(insurance.answer).toContain("Blue Cross Blue Shield");
    expect(insurance.answer).toContain("Total: $438.44");
    expect(insurance.answer).not.toContain("OBGYN");
    expect(insurance.answer).not.toContain("WALGREENS");
    expect(insurance.answer).not.toContain("LOWE");
    expect(insurance.answer).not.toContain("PEAK SEASONS");

    const medical = await query(email, "How much did I spend on medical?");
    expect(medical.answer).toContain("OBGYN");
    expect(medical.answer).toContain("WALGREENS");
    expect(medical.answer).toContain("Total: $67.39");
    expect(medical.answer).not.toContain("Blue Cross");
    expect(medical.answer).not.toContain("LOWE");

    const car = await query(email, "How about car insurance?");
    expect(car.answer).toBe("No car insurance charges were found.");
    expect(car.answer).not.toContain("LOWE");
    expect(car.answer).not.toContain("PEAK SEASONS");
    expect(car.answer).not.toContain("OBGYN");
    expect(car.answer).not.toContain("WALGREENS");
    expect(car.answer).not.toContain("Blue Cross");
    expect(car.answer).not.toContain("578.05");

    const withAuto = "auto-insurance@example.com";
    expect(
      (
        await upload(
          withAuto,
          csvOf([
            ["2026-10-01", "GEICO", "-90.00"],
            ["2026-10-02", "LOWE'S", "-17.06"],
            ["2026-10-03", "CARY OBGYN 919-4675941", "-50.00"],
            ["2026-10-04", "BLUE CROSS BLUE SHIELD", "-438.44"],
          ]),
        )
      ).status,
    ).toBe(200);
    await query(withAuto, "How much did I spent in insurance?");
    const onlyCar = await query(withAuto, "How about car insurance?");
    expect(onlyCar.answer).toContain("GEICO");
    expect(onlyCar.answer).toContain("Total: $90.00");
    expect(onlyCar.answer).not.toContain("LOWE");
    expect(onlyCar.answer).not.toContain("OBGYN");
    expect(onlyCar.answer).not.toContain("Blue Cross");
  });

  it("keeps a signed credit as income and rechecks a stale ledger once", async () => {
    const email = "signed-credit@example.com";
    vi.spyOn(env.AI, "run").mockImplementation(async () => {
      throw new Error("rules cover the credit");
    });
    const stub = env.LEDGER.get(env.LEDGER.idFromName(ledgerName(email)));
    await stub.replace(
      [
        {
          payload: { Date: "2026-10-01", Description: "CHIPOTLE", Amount: "-10.00" },
          category: "dining",
        },
        {
          payload: { Date: "2026-10-02", Description: "MYSTERY CREDIT 42", Amount: "5.00" },
          category: "dining",
        },
      ],
      { startDate: "2026-10-01", endDate: "2026-10-02" },
    );
    const spent = await query(email, "How much did I spend?");
    expect(spent.answer).toContain("CHIPOTLE");
    expect(spent.answer).toContain("Total: $10.00");
    expect(spent.answer).not.toContain("5.00");
    const once = await stub.load();
    expect(
      once.records.find((row) => row.payload.Description === "MYSTERY CREDIT 42")?.category,
    ).toBe("income");
    const again = await query(email, "How much did I spend?");
    expect(again.answer).toContain("Total: $10.00");
    const twice = await stub.load();
    expect(
      twice.records.find((row) => row.payload.Description === "MYSTERY CREDIT 42")?.category,
    ).toBe("income");
    const stamp = await runInDurableObject(stub, async (_instance, state) => {
      return state.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM ledger_meta WHERE key = 'category_rules_version'",
        )
        .toArray()[0]?.value;
    });
    expect(stamp).toBe(CATEGORY_RULES_VERSION);
  });
});
