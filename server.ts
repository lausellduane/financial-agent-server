import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import csv from "csv-parser";
import fs from "fs";
import path from "path"; // Crucial for Windows backslash normalization
import { Readable } from "node:stream";
import process from "node:process";
import { fileURLToPath } from "url";
import {
  accessMiddleware,
  ledgerId,
  onWorkers,
  type AccessIdentity,
} from "./access.js";
import { MAX_LEDGER_ROWS, MAX_UPLOAD_BYTES, PORT } from "./constants.js";
import {
  completeChat,
  llmProvider,
  ollamaModel,
  workersAiModel,
} from "./llm.js";

// 👇 RECREATE __dirname FOR ES MODULES
// Workers bundles do not always set import.meta.url. Node (tsx) does.
const moduleUrl = import.meta.url;
const __filename =
  typeof moduleUrl === "string" && moduleUrl.length > 0
    ? fileURLToPath(moduleUrl)
    : "";
const __dirname = __filename ? path.dirname(__filename) : "/tmp";

const app: Express = express();

// Workers populates process.env from wrangler vars and secrets
// (compatibility date on or after 2025-04-01). dotenv is not used here.
const LOCAL_DEV_ORIGINS = ["http://localhost:8081", "http://localhost:19006"];

function allowedOrigins(): string[] | false {
  const configured = (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin !== "*");
  if (onWorkers()) return configured.length > 0 ? configured : false;
  return configured.length > 0 ? configured : LOCAL_DEV_ORIGINS;
}

app.use((req, res, next) => {
  const origin = allowedOrigins();
  // Production traffic is same-origin, so origin is false and CORS stays off.
  // Dev still allows localhost (or CORS_ORIGIN) and must echo credentials.
  cors(
    origin === false
      ? { origin: false }
      : {
          origin,
          credentials: true,
          allowedHeaders: ["Content-Type"],
        },
  )(req, res, next);
});
app.use(express.json());
app.use("/api", accessMiddleware);

// Workers' /tmp is a per-request virtual disk. Multer's disk engine writes
// the upload and then the file is gone, so Workers keeps the CSV in memory.
// Node still uses a real directory next to this file (Windows path safe).
const upload = multer({
  ...(onWorkers()
    ? { storage: multer.memoryStorage() }
    : { dest: path.join(__dirname, "uploads") }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// Node keeps one statement in this process. The Worker stores each Access
// identity in its own Ledger Durable Object.
let transactionData: Record<string, string>[] = [];
let transactionUploadedAt: string | null = null;
let transactionStartDate: string | null = null;
let transactionEndDate: string | null = null;

async function ledgerStub(identity: AccessIdentity) {
  const { env } = await import("cloudflare:workers");
  return env.LEDGER.get(env.LEDGER.idFromName(ledgerId(identity)));
}

async function readLedger(
  identity: AccessIdentity | undefined,
): Promise<Record<string, string>[]> {
  if (!onWorkers()) return transactionData;
  if (!identity) throw new Error("Missing Access identity");
  return (await ledgerStub(identity)).load();
}

async function writeLedger(
  rows: Record<string, string>[],
  identity: AccessIdentity | undefined,
): Promise<void> {
  const range = rows.length
    ? dateRange(rows)
    : { startDate: null, endDate: null };
  if (!onWorkers()) {
    transactionData = rows;
    transactionUploadedAt = rows.length ? new Date().toISOString() : null;
    transactionStartDate = range.startDate;
    transactionEndDate = range.endDate;
    return;
  }
  if (!identity) throw new Error("Missing Access identity");
  await (await ledgerStub(identity)).replace(rows, range);
}

const GROCERY_TOKENS = [
  "COSTCO",
  "WALMART",
  "WAL-MART",
  "WAL MART",
  "SAM'S CLUB",
  "SAMS CLUB",
  "TRADER JOE",
  "FOOD LION",
  "KROGER",
  "PUBLIX",
  "ALDI",
  "HARRIS TEETER",
  "WEGMANS",
  "SAFEWAY",
  "ALBERTSONS",
  "WHOLE FOODS",
  "SPROUTS",
  "TARGET",
  "BJ'S",
  "BJS WHOLESALE",
  "LIDL",
  "H-E-B",
  "HEB ",
  "GIANT FOOD",
  "GIANT EAGLE",
  "WINN DIXIE",
  "WINN-DIXIE",
  "INSTACART",
  "HELLOFRESH",
  "BLUE APRON",
  "FRESH DIRECT",
  "AMAZON MKT",
  "AMZN MKT",
  "AMAZON.COM*MKT",
  "AMAZON RETAIL",
];

const PHARMACY_TOKENS = [
  "CVS",
  "WALGREENS",
  "RITE AID",
  "RITEAID",
];

const GAS_STATION_TOKENS = [
  "EXXON",
  "CHEVRON",
  "SHELL OIL",
  "SHELL SERVICE",
  "SUNOCO",
  "TEXACO",
  "7-ELEVEN",
  "7 ELEVEN",
  "SHEETZ",
  "WAWA",
  "BP ",
  "MOBIL",
  "MARATHON",
  "SPEEDWAY",
  "VALERO",
  "CIRCLE K",
  "RACETRAC",
  "PILOT",
  "LOVE'S",
  "LOVES ",
  "QT ",
  "QUIKTRIP",
];

const TRANSPORT_TOKENS = [
  "UBER",
  "LYFT",
  "METRO",
  "TRANSIT",
  "PARKING",
  "PARKWHIZ",
  "SPOTHERO",
  "EZPASS",
  "E-ZPASS",
  "TOLL",
  "AMTRAK",
  "GREYHOUND",
  "ENTERPRISE RENT",
  "HERTZ",
  "BUDGET RENT",
  "NATIONAL CAR",
];

const SHOPPING_TOKENS = [
  "AMAZON",
  "AMZN",
  "EBAY",
  "ETSY",
  "WALMART.COM",
  "TARGET.COM",
  "BEST BUY",
  "BESTBUY",
  "APPLE.COM/BILL",
  "APPLE STORE",
  "NORDSTROM",
  "MACY",
  "KOHL'S",
  "KOHLS",
  "TJ MAXX",
  "T.J. MAXX",
  "MARSHALLS",
  "ROSS STORES",
  "OLD NAVY",
  "GAP ",
  "H&M",
  "ZARA",
  "SHEIN",
  "NIKE",
  "ADIDAS",
];

const ENTERTAINMENT_TOKENS = [
  "NETFLIX",
  "HULU",
  "DISNEY+",
  "DISNEY PLUS",
  "MAX.COM",
  "HBO",
  "SPOTIFY",
  "APPLE MUSIC",
  "YOUTUBE TV",
  "YOUTUBEPREMIUM",
  "AMC",
  "REGAL",
  "CINEMARK",
  "IMAX",
  "TICKETMASTER",
  "STUBHUB",
  "STEAM",
  "PLAYSTATION",
  "XBOX",
  "NINTENDO",
  "TWITCH",
];

const TRAVEL_TOKENS = [
  "AIRBNB",
  "VRBO",
  "BOOKING.COM",
  "EXPEDIA",
  "HOTELS.COM",
  "MARRIOTT",
  "HILTON",
  "HYATT",
  "IHG",
  "DELTA",
  "UNITED AIR",
  "AMERICAN AIR",
  "SOUTHWEST",
  "JETBLUE",
  "SPIRIT AIR",
  "FRONTIER AIR",
  "AIRLINE",
  "AIRPORT",
];

const HEALTH_TOKENS = [
  ...PHARMACY_TOKENS,
  "DOCTOR",
  "DENTAL",
  "DENTIST",
  "HOSPITAL",
  "URGENT CARE",
  "LABCORP",
  "QUEST DIAG",
  "PLANNED PARENTHOOD",
  "OPTUM",
  "KAISER",
];

const SUBSCRIPTION_TOKENS = [
  "NETFLIX",
  "HULU",
  "SPOTIFY",
  "DISNEY+",
  "APPLE.COM/BILL",
  "GOOGLE *YOUTUBE",
  "ICLOUD",
  "ICLOUD+",
  "MICROSOFT",
  "ADOBE",
  "DROPBOX",
  "OPENAI",
  "CHATGPT",
  "GITHUB",
  "PATREON",
];

const HOME_TOKENS = [
  "HOME DEPOT",
  "LOWE'S",
  "LOWES",
  "ACE HARDWARE",
  "MENARDS",
  "IKEA",
  "WAYFAIR",
  "BED BATH",
];

const PET_TOKENS = [
  "PETSMART",
  "PETCO",
  "CHEWY",
  "VET",
  "VETERINAR",
  "PET SUPPLY",
];

const FITNESS_TOKENS = [
  "PLANET FITNESS",
  "LA FITNESS",
  "EQUINOX",
  "ORANGE THEORY",
  "ORANGETHEORY",
  "PELOTON",
  "YMCA",
  "CRUNCH FITNESS",
  "ANYTIME FITNESS",
];

const EDUCATION_TOKENS = [
  "TUITION",
  "UNIVERSITY",
  "COLLEGE",
  "UDEMY",
  "COURSERA",
  "SKILLSHARE",
  "CHEGG",
  "SCHOOL",
];

const PERSONAL_CARE_TOKENS = [
  "ULTA",
  "SEPHORA",
  "GREAT CLIPS",
  "SUPERCUTS",
  "SUPER CUTS",
  "BARBER",
  "SALON",
];

const MEDICAL_INSURANCE_TOKENS = [
  "BLUE CROSS",
  "BLUE SHIELD",
  "BCBS",
  "ANTHEM",
  "CIGNA",
  "AETNA",
  "HUMANA",
  "UNITEDHEALTH",
  "UNITED HEALTH",
  "UHC",
  "KAISER",
  "MEDICARE",
  "MEDICAID",
];

const NOT_BILL_TOKENS = [
  "HOBBY LOBBY",
  "MY529",
  "529",
  "INVESTMENT",
  "VANGUARD",
  "ROBINHOOD",
  "COINBASE",
];

const BILL_KEYWORDS = [
  "PIEDMONT NATURAL GAS",
  "PIEDMONT NATURALG",
  "PIEDMONT NATURAL",
  "SPI*PIEDMONT",
  "TOWN OF GARNER",
  "DUKE ENERGY",
  "DOMINION ENERGY",
  "PG&E",
  "CON EDISON",
  "CONEDISON",
  "FLORIDA POWER",
  "SPECTRUM",
  "COMCAST",
  "XFINITY",
  "AT&T",
  "ATT*",
  "VERIZON",
  "T-MOBILE",
  "TMOBILE",
  "GEICO",
  "STATE FARM",
  "PROGRESSIVE",
  "ALLSTATE",
  "USAA",
  "NATIONWIDE",
  "WASTE MANAGEMENT",
  "REPUBLIC SERVICES",
  "PUBLIC UTIL",
  "WATER DEPT",
  "WATER DEPARTMENT",
  "MUNICIPAL",
  "MORTGAGE",
  "HOA",
  "INSURANCE",
  "PLANET HOME",
  "HOME LENDING",
  "HOME LOAN",
  "HOMEOWNER",
  "AWS",
  "AMAZON WEB",
  "AMAZON WEB SERVICES",
  "AMZN WEB",
  "AWS.AMAZON",
  "AWS.AMAZON.CO",
];

const HARD_EXCLUDE_TOKENS = [
  ...GROCERY_TOKENS,
  ...PHARMACY_TOKENS,
  ...GAS_STATION_TOKENS,
  "PIEDMONT NATURAL GAS",
  "TOWN OF GARNER",
];

const EATING_OUT_KEYWORDS = [
  "CHIPOTLE",
  "MCDONALD",
  "BURGER KING",
  "WENDY'S",
  "WENDYS",
  "TACO BELL",
  "CHICK-FIL",
  "CHICK FIL",
  "CHICKFILA",
  "SONIC",
  "ARBY",
  "SUBWAY",
  "POPEYES",
  "KFC",
  "COOK OUT",
  "COOKOUT",
  "RAISING CANE",
  "FIVE GUYS",
  "IN-N-OUT",
  "IN N OUT",
  "SHAKE SHACK",
  "CULVER",
  "WHATABURGER",
  "QDOBA",
  "MOE'S",
  "FIREHOUSE SUB",
  "JERSEY MIKE",
  "JIMMY JOHN",
  "PANDA EXPRESS",
  "OLIVE GARDEN",
  "APPLEBEE",
  "CHILI'S",
  "CHILIS",
  "OUTBACK",
  "IHOP",
  "DENNY",
  "CRACKER BARREL",
  "TEXAS ROADHOUSE",
  "BUFFALO WILD",
  "WINGSTOP",
  "ZAXBY",
  "BOJANGLE",
  "DOMINO",
  "PIZZA HUT",
  "PAPA JOHN",
  "LITTLE CAESAR",
  "STARBUCKS",
  "DUNKIN",
  "DUTCH BROS",
  "KRISPY KREME",
  "WAFFLE HOUSE",
  "UBER EATS",
  "UBER*EATS",
  "DOORDASH",
  "DOOR DASH",
  "GRUBHUB",
  "GRUB HUB",
  "POSTMATES",
  "RESTAURANT",
  "TAQUERIA",
  "PIZZERIA",
  "PIZZA",
  "SUSHI",
  "BISTRO",
  "DINER",
  "BAR & GRILL",
  "BAR AND GRILL",
  "CAFE",
  "CAFÉ",
  "COFFEE",
  "BBQ",
  "BARBECUE",
];

function normalizeRow(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    const cleanKey = key.replace(/^\uFEFF/, "").trim();
    out[cleanKey] = value == null ? "" : String(value).trim();
  }
  return out;
}

function isBlankMerchant(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return /^(no description|n\/?a|none|null|undefined|-|—|--|\.|processing|pending|settled)$/i.test(
    trimmed,
  );
}

function countCsvSkipLines(content: string): number {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const line = lines[i].replace(/^\uFEFF/, "").replace(/"/g, "");
    const lower = line.toLowerCase();
    if (
      /\b(run date|date)\b/.test(lower) &&
      /\b(action|description|transaction|payee|merchant)\b/.test(lower)
    ) {
      return i;
    }
  }
  return 0;
}

function findField(keys: string[], candidates: string[]): string | undefined {
  const byLower = new Map(keys.map((key) => [key.toLowerCase(), key]));
  for (const candidate of candidates) {
    const match = byLower.get(candidate.toLowerCase());
    if (match) return match;
  }
  for (const candidate of candidates) {
    const needle = candidate.toLowerCase();
    const startsWith = keys.find((key) => key.toLowerCase().startsWith(needle));
    if (startsWith) return startsWith;
  }
  return undefined;
}

function columnStats(rows: Record<string, string>[], field: string) {
  const unique = new Set<string>();
  const samples: string[] = [];
  let nonEmpty = 0;
  for (const row of rows) {
    const value = String(row[field] ?? "").trim();
    if (isBlankMerchant(value)) continue;
    nonEmpty += 1;
    const key = value.toUpperCase();
    if (!unique.has(key)) {
      unique.add(key);
      if (samples.length < 5) samples.push(value);
    }
  }
  return { field, nonEmpty, unique: unique.size, samples };
}

function isMostlyNumericColumn(
  rows: Record<string, string>[],
  field: string,
): boolean {
  let seen = 0;
  let numeric = 0;
  for (const row of rows) {
    const value = String(row[field] ?? "").trim();
    if (!value) continue;
    seen += 1;
    if (/^[$(-]?[\d,.]+\)?$/.test(value.replace(/\s/g, ""))) numeric += 1;
  }
  return seen > 0 && numeric / seen > 0.8;
}

function pickMerchantField(rows: Record<string, string>[]): string {
  const keys = Object.keys(rows[0] ?? {});
  let best = keys.find((key) => /desc|action|payee|name|merchant|memo/i.test(key))
    ?? keys[0]
    ?? "Description";
  let bestScore = -1;

  for (const key of keys) {
    const stats = columnStats(rows, key);
    if (!stats.nonEmpty) continue;
    if (isMostlyNumericColumn(rows, key)) continue;
    if (
      /^(amount|amt|quantity|qty|price|commission|fees?|balance|account|symbol|type|status|checknumber)$/i.test(
        key,
      )
    ) {
      continue;
    }

    let score = stats.unique * 2 + stats.nonEmpty;
    if (/^action$/i.test(key)) score += 100;
    if (/action|payee|name|merchant|memo|details|transaction/i.test(key)) {
      score += 30;
    }
    if (/desc/i.test(key)) score += 10;
    if (/date/i.test(key)) score -= 80;
    if (
      stats.samples.some((sample) =>
        /DEBIT CARD PURCHASE|ELECTRONIC WITHDRAWAL|POS DEBIT|VISA DEBIT/i.test(
          sample,
        ),
      )
    ) {
      score += 200;
    }
    const avgLen =
      stats.samples.reduce((sum, sample) => sum + sample.length, 0) /
      Math.max(stats.samples.length, 1);
    score += avgLen;

    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }

  return best;
}

function calendarDate(raw: string | undefined): string | undefined {
  const text = String(raw ?? "").trim();
  if (!text) return undefined;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(text);
  let year: number;
  let month: number;
  let day: number;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (us) {
    month = Number(us[1]);
    day = Number(us[2]);
    year = Number(us[3]);
    if (year < 100) year += 2000;
  } else {
    return undefined;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateRange(rows: Record<string, string>[]): {
  startDate: string | null;
  endDate: string | null;
} {
  const field = pickDisplayFields(rows).date;
  let startDate: string | null = null;
  let endDate: string | null = null;
  if (!field) return { startDate, endDate };
  for (const row of rows) {
    const key = calendarDate(row[field]);
    if (!key) continue;
    if (!startDate || key < startDate) startDate = key;
    if (!endDate || key > endDate) endDate = key;
  }
  return { startDate, endDate };
}

export type ReportSummary = {
  loaded: boolean;
  count: number;
  startDate: string | null;
  endDate: string | null;
  uploadedAt: string | null;
};

async function reportFor(
  identity: AccessIdentity | undefined,
): Promise<ReportSummary> {
  if (!onWorkers()) {
    const count = transactionData.length;
    return {
      loaded: count > 0,
      count,
      startDate: count > 0 ? transactionStartDate : null,
      endDate: count > 0 ? transactionEndDate : null,
      uploadedAt: count > 0 ? transactionUploadedAt : null,
    };
  }
  if (!identity) throw new Error("Missing Access identity");
  return (await ledgerStub(identity)).summary();
}

function pickDisplayFields(rows: Record<string, string>[]) {
  const keys = Object.keys(rows[0] ?? {});
  return {
    date:
      findField(keys, [
        "Date",
        "Run Date",
        "Transaction Date",
        "Trans. Date",
        "Trans Date",
        "Posted Date",
        "Post Date",
        "Posting Date",
      ]) ?? keys[0],
    description: pickMerchantField(rows),
    amount:
      findField(keys, [
        "Amount",
        "Transaction Amount",
        "Amt",
        "Withdrawal",
        "Withdrawal (-)",
        "Withdrawal(-)",
        "Debit",
        "Debit Amount",
        "Credit",
        "Amount ($)",
      ]) ?? keys.find((key) => /amount/i.test(key)) ?? keys[2],
  };
}

function uniqueMerchants(
  rows: Record<string, string>[],
  field: string,
  limit = 400,
): string[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const row of rows) {
    const raw = String(row[field] ?? "").trim();
    if (isBlankMerchant(raw)) continue;
    const key = raw.toUpperCase();
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { label: raw, count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((entry) => entry.label);
}

function compactMerchant(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function containsToken(text: string, token: string): boolean {
  const haystack = text.toUpperCase();
  const needle = token.toUpperCase();
  if (!needle) return false;
  if (/^[A-Z0-9]{2,3}$/.test(needle)) {
    return new RegExp(`(^|[^A-Z0-9])${needle}([^A-Z0-9]|$)`).test(haystack);
  }
  if (haystack.includes(needle)) return true;

  // Fidelity truncates and drops spaces: "PIEDMONT NATURAL GAS" → "PIEDMONT NATURALG"
  const compactHay = compactMerchant(text);
  const compactNeedle = compactMerchant(token);
  if (compactNeedle.length >= 8 && compactHay.includes(compactNeedle)) {
    return true;
  }
  if (compactNeedle.length >= 10) {
    const prefix = compactNeedle.slice(0, 12);
    if (compactHay.includes(prefix)) return true;
  }
  return false;
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((token) => containsToken(text, token));
}

function rowNarrative(
  row: Record<string, string>,
  merchantField: string,
): string {
  const skipField =
    /date|amount|qty|quantity|price|commission|fees?|balance|account|symbol|type|status|settlement/i;
  const parts: string[] = [];
  const primary = String(row[merchantField] ?? "").trim();
  if (!isBlankMerchant(primary)) parts.push(primary);
  for (const [key, value] of Object.entries(row)) {
    if (key === merchantField) continue;
    if (skipField.test(key)) continue;
    if (isBlankMerchant(value)) continue;
    parts.push(value);
  }
  return parts.join(" ").toUpperCase();
}

const GENERIC_INCLUDE_TOKENS = new Set([
  "0",
  "CASH",
  "DEBIT",
  "CREDIT",
  "PURCHASE",
  "PAYMENT",
  "PAY",
  "DIRECT",
  "WITHDRAWAL",
  "ELECTRONIC",
  "CARD",
  "PENDING",
  "PROCESSING",
  "SETTLED",
  "TRANSFER",
  "ACH",
  "BANK",
  "BILL",
  "TYPE",
  "ACTION",
]);

const US_STATE_CODES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DC",
  "DE",
  "FL",
  "GA",
  "HI",
  "IA",
  "ID",
  "IL",
  "IN",
  "KS",
  "KY",
  "LA",
  "MA",
  "MD",
  "ME",
  "MI",
  "MN",
  "MO",
  "MS",
  "MT",
  "NC",
  "ND",
  "NE",
  "NH",
  "NJ",
  "NM",
  "NV",
  "NY",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VA",
  "VT",
  "WA",
  "WI",
  "WV",
  "WY",
]);

function isUsefulIncludeToken(token: string): boolean {
  const normalized = token.trim().toUpperCase();
  if (normalized.length < 4) return false;
  if (GENERIC_INCLUDE_TOKENS.has(normalized)) return false;
  if (/^\d+$/.test(normalized)) return false;
  return true;
}

function parseAmount(raw: string | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[$,]/g, "").trim();
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : 0;
}

type SpendCategory = {
  name: string;
  questionPattern: RegExp;
  keywords: string[];
  excludeTokens: string[];
  llmInclude: string;
  llmExclude: string;
};

const SPEND_CATEGORIES: SpendCategory[] = [
  {
    name: "medical insurance",
    questionPattern:
      /\b((?:medical|health)\s+insurance|blue cross|blue shield|bcbs)\b/i,
    keywords: MEDICAL_INSURANCE_TOKENS,
    excludeTokens: [
      ...EATING_OUT_KEYWORDS,
      ...GROCERY_TOKENS,
      ...NOT_BILL_TOKENS,
      "PIEDMONT",
      "DUKE ENERGY",
      "TOWN OF GARNER",
      "PLANET HOME",
      "AWS",
      "AT&T",
      "ATT*",
    ],
    llmInclude:
      "health/medical insurance premiums only (Blue Cross Blue Shield, Anthem, Cigna, Aetna, Humana, UnitedHealthcare, Kaiser). Not utilities, mortgage, or other bills.",
    llmExclude:
      "utilities, Piedmont, Duke Energy, town bills, mortgage, phone, AWS, groceries, restaurants, shopping, investments, 529, Hobby Lobby",
  },
  {
    name: "eating out",
    questionPattern:
      /\b(eat(?:ing)? out|restaurants?|fast food|take-?out|takeout|dining out|doordash|uber eats|food delivery)\b/i,
    keywords: EATING_OUT_KEYWORDS,
    excludeTokens: HARD_EXCLUDE_TOKENS,
    llmInclude:
      "restaurants, fast food, cafes, coffee shops, food trucks, pizza places, bars with food, Uber Eats, DoorDash, Grubhub",
    llmExclude:
      "groceries, Costco, Walmart, Trader Joe's, Target, pharmacies, gas stations, utilities, banks, transfers, ATM, payroll, insurance, rent, town bills",
  },
  {
    name: "bills",
    questionPattern:
      /\b(bills?|utilities|utility bill|rent|mortgage|electric|internet bill|(?<!(?:medical|health|life)\s)insurance)\b/i,
    keywords: BILL_KEYWORDS,
    excludeTokens: [
      ...EATING_OUT_KEYWORDS,
      ...GROCERY_TOKENS,
      ...NOT_BILL_TOKENS,
    ],
    llmInclude:
      "utilities, town/city bills, electric, natural gas (not gas stations), water, sewer, trash, internet, cable, phone, rent, mortgage, mortgage servicers (Planet Home, loan ACH payments), HOA, and cloud/software bills (AWS, Amazon Web Services). Auto/home insurance (Geico, State Farm) counts. Medical insurance (Blue Cross) does not unless the user asked for all bills.",
    llmExclude:
      "restaurants, fast food, groceries, shopping (Hobby Lobby), transfers, ATM, payroll, investments, 529 contributions, Amazon retail/marketplace",
  },
  {
    name: "groceries",
    questionPattern: /\b(grocer(?:y|ies)|supermarket)\b/i,
    keywords: GROCERY_TOKENS,
    excludeTokens: [...EATING_OUT_KEYWORDS, ...BILL_KEYWORDS],
    llmInclude:
      "grocery stores, supermarkets, wholesale clubs used for groceries (Costco, Sam's Club, Walmart, Target groceries), Trader Joe's, Food Lion, Kroger, Aldi, Instacart, Amazon fresh/marketplace grocery",
    llmExclude:
      "restaurants, fast food, cafes, utilities, town bills, mortgage, insurance, AWS, gas stations, transfers, ATM, payroll, pharmacies",
  },
  {
    name: "coffee",
    questionPattern: /\b(coffee|starbucks|dunkin|cafe)\b/i,
    keywords: ["STARBUCKS", "DUNKIN", "DUTCH BROS", "PEET'S", "PEETS", "COFFEE"],
    excludeTokens: [...GROCERY_TOKENS, ...BILL_KEYWORDS],
    llmInclude: "coffee shops (Starbucks, Dunkin, Dutch Bros, Peet's)",
    llmExclude: "restaurants that are not coffee, groceries, bills",
  },
  {
    name: "gas",
    questionPattern: /\b(gas stations?|fuel|gasoline|petrol|gas)\b/i,
    keywords: GAS_STATION_TOKENS,
    excludeTokens: [
      ...EATING_OUT_KEYWORDS,
      ...GROCERY_TOKENS,
      "PIEDMONT NATURAL GAS",
    ],
    llmInclude:
      "gas stations and vehicle fuel (Exxon, Chevron, Shell, BP, Sheetz, Wawa, Circle K)",
    llmExclude:
      "natural gas utilities (Piedmont), restaurants, groceries, shopping",
  },
  {
    name: "transportation",
    questionPattern:
      /\b(transport(?:ation)?|uber|lyft|rideshare|transit|parking|tolls?|commute|car rental)\b/i,
    keywords: TRANSPORT_TOKENS,
    excludeTokens: [
      "UBER EATS",
      "UBER*EATS",
      ...EATING_OUT_KEYWORDS,
      ...GROCERY_TOKENS,
    ],
    llmInclude:
      "rideshare trips (Uber/Lyft, not Uber Eats), transit, parking, tolls, car rentals",
    llmExclude:
      "Uber Eats, DoorDash, groceries, restaurants, gas stations (unless asking about transport broadly), airlines/hotels",
  },
  {
    name: "health",
    questionPattern:
      /\b(health|medical|doctor|dentist|dental|pharmacy|prescription|hospital)\b/i,
    keywords: HEALTH_TOKENS,
    excludeTokens: [...EATING_OUT_KEYWORDS, ...BILL_KEYWORDS],
    llmInclude:
      "pharmacies (CVS, Walgreens), doctors, dentists, hospitals, urgent care, lab tests",
    llmExclude:
      "utilities, natural gas companies (Piedmont Natural Gas, SPI*PIEDMONT), electric (Duke Energy), town bills, groceries, restaurants, gyms, insurance premiums (those are bills)",
  },
  {
    name: "travel",
    questionPattern:
      /\b(travel|hotel|hotels|flight|flights|airline|airbnb|vacation|trip)\b/i,
    keywords: TRAVEL_TOKENS,
    excludeTokens: [...EATING_OUT_KEYWORDS, ...GROCERY_TOKENS],
    llmInclude: "airlines, hotels, Airbnb, booking sites, airport charges",
    llmExclude: "local Uber/Lyft, restaurants, groceries, everyday shopping",
  },
  {
    name: "subscriptions",
    questionPattern:
      /\b(subscriptions?|streaming|netflix|spotify|memberships?)\b/i,
    keywords: SUBSCRIPTION_TOKENS,
    excludeTokens: [...GROCERY_TOKENS, ...GAS_STATION_TOKENS],
    llmInclude:
      "recurring software and streaming (Netflix, Spotify, iCloud, Adobe, Microsoft, ChatGPT)",
    llmExclude: "one-off shopping, groceries, restaurants, utilities, gym if asked separately",
  },
  {
    name: "entertainment",
    questionPattern:
      /\b(entertainment|movies?|concerts?|games?|gaming|theater|tickets?)\b/i,
    keywords: ENTERTAINMENT_TOKENS,
    excludeTokens: [...GROCERY_TOKENS, ...BILL_KEYWORDS],
    llmInclude:
      "movies, concerts, games, streaming, ticket sites, theaters, PlayStation/Xbox/Steam",
    llmExclude: "groceries, restaurants, utilities, shopping for clothes",
  },
  {
    name: "shopping",
    questionPattern:
      /\b(shopping|clothes|clothing|apparel|amazon|retail|online shopping)\b/i,
    keywords: SHOPPING_TOKENS,
    excludeTokens: [
      ...EATING_OUT_KEYWORDS,
      ...BILL_KEYWORDS,
      "AWS",
      "AMAZON WEB",
      "AWS.AMAZON",
    ],
    llmInclude:
      "retail and online shopping (Amazon marketplace, clothing, Best Buy, department stores). Not AWS.",
    llmExclude:
      "Amazon Web Services, groceries (Costco/Walmart grocery), restaurants, bills, gas",
  },
  {
    name: "home",
    questionPattern:
      /\b(home improvement|home depot|lowe'?s|hardware|household|ikea)\b/i,
    keywords: HOME_TOKENS,
    excludeTokens: [...EATING_OUT_KEYWORDS, ...GROCERY_TOKENS],
    llmInclude:
      "home improvement and household goods (Home Depot, Lowe's, Ace, IKEA, Wayfair)",
    llmExclude: "groceries, restaurants, mortgage/HOA bills, furniture classified as shopping if unclear",
  },
  {
    name: "pets",
    questionPattern: /\b(pets?|vet|veterinar|petco|petsmart|chewy)\b/i,
    keywords: PET_TOKENS,
    excludeTokens: [...EATING_OUT_KEYWORDS, ...BILL_KEYWORDS],
    llmInclude: "pet stores, vet clinics, Chewy, Petco, PetSmart",
    llmExclude: "groceries, restaurants, human pharmacies unless clearly pet",
  },
  {
    name: "fitness",
    questionPattern: /\b(fitness|gym|workout|peloton|planet fitness)\b/i,
    keywords: FITNESS_TOKENS,
    excludeTokens: [...EATING_OUT_KEYWORDS, ...GROCERY_TOKENS],
    llmInclude: "gyms, fitness studios, Peloton, YMCA, Planet Fitness",
    llmExclude: "restaurants, groceries, medical, sports tickets (entertainment)",
  },
  {
    name: "education",
    questionPattern:
      /\b(education|tuition|school|college|university|courses?|udemy)\b/i,
    keywords: EDUCATION_TOKENS,
    excludeTokens: [...EATING_OUT_KEYWORDS, ...GROCERY_TOKENS],
    llmInclude: "tuition, schools, universities, online courses",
    llmExclude: "restaurants, groceries, entertainment, shopping",
  },
  {
    name: "personal care",
    questionPattern:
      /\b(personal care|salon|barber|haircut|ulta|sephora|beauty)\b/i,
    keywords: PERSONAL_CARE_TOKENS,
    excludeTokens: [...EATING_OUT_KEYWORDS, ...GROCERY_TOKENS],
    llmInclude: "salons, barbers, Ulta, Sephora, beauty and haircuts",
    llmExclude: "pharmacies/medical, groceries, clothing stores",
  },
];

const MERCHANT_ALIASES: Array<{
  pattern: RegExp;
  tokens: string[];
  name: string;
}> = [
  { pattern: /\bcostco\b/i, tokens: ["COSTCO"], name: "Costco" },
  {
    pattern: /\bwalmart\b|\bwm supercenter\b/i,
    tokens: ["WALMART", "WAL-MART", "WAL MART", "WM SUPERCENTER"],
    name: "Walmart",
  },
  {
    pattern: /\btrader joe/i,
    tokens: ["TRADER JOE"],
    name: "Trader Joe's",
  },
  { pattern: /\bfood lion\b/i, tokens: ["FOOD LION"], name: "Food Lion" },
  { pattern: /\btarget\b/i, tokens: ["TARGET"], name: "Target" },
  { pattern: /\bpublix\b/i, tokens: ["PUBLIX"], name: "Publix" },
  { pattern: /\bchipotle\b/i, tokens: ["CHIPOTLE"], name: "Chipotle" },
  { pattern: /\bstarbucks\b/i, tokens: ["STARBUCKS"], name: "Starbucks" },
  { pattern: /\bdunkin\b/i, tokens: ["DUNKIN"], name: "Dunkin" },
  { pattern: /\bhobby lobby\b/i, tokens: ["HOBBY LOBBY"], name: "Hobby Lobby" },
  {
    pattern: /\baws\b|amazon web services/i,
    tokens: ["AWS", "AMAZON WEB", "AWS.AMAZON", "AWS.AMAZON.CO"],
    name: "Amazon Web Services",
  },
];

const CATEGORY_TOPIC_WORDS =
  /^(groceries|grocery|bills?|utilities|restaurants?|food|eating out|shopping|travel|health|insurance|gas|transportation|entertainment|subscriptions?)$/i;

function findAskedMerchant(
  question: string,
  txs: NormalizedTx[],
): { tokens: string[]; name: string } | undefined {
  const alias = MERCHANT_ALIASES.find((item) => item.pattern.test(question));
  if (alias) return { tokens: alias.tokens, name: alias.name };

  const named = String(question ?? "").match(
    /(?:\bat\b|\bin\b|\bon\b|\bfrom\b)\s+(.+?)[?.!]*$/i,
  );
  const topic = named?.[1]?.replace(/\b(last|this|my|the)\b/gi, " ").trim();
  if (!topic || CATEGORY_TOPIC_WORDS.test(topic)) return undefined;

  const compactTopic = compactMerchant(topic);
  if (compactTopic.length < 3) return undefined;

  const hits = txs.filter((tx) => {
    const text = `${tx.merchant} ${Object.values(tx.raw).join(" ")}`;
    if (compactTopic.length <= 3) return containsToken(text, compactTopic);
    return compactMerchant(text).includes(compactTopic);
  });
  if (!hits.length) return undefined;
  return { tokens: [topic.toUpperCase()], name: topic };
}

function findSpendCategory(question: string): SpendCategory | undefined {
  const known = SPEND_CATEGORIES.find((category) =>
    category.questionPattern.test(question),
  );
  if (known) return known;

  const spendOn = String(question ?? "").match(
    /(?:how much|spent|spend|spending).*(?:\bon\b|\bin\b|\bfor\b)\s+(.+?)[?.!]*$/i,
  );
  if (!spendOn?.[1]) return undefined;

  const topic = spendOn[1].replace(/\b(last|this|my|the)\b/gi, " ").trim();
  if (!topic || topic.length > 60) return undefined;
  if (MERCHANT_ALIASES.some((alias) => alias.pattern.test(topic))) {
    return undefined;
  }
  if (compactMerchant(topic).length <= 3) return undefined;

  return {
    name: topic,
    questionPattern: /.*/,
    keywords: [],
    excludeTokens: [],
    llmInclude: topic,
    llmExclude:
      "unrelated merchants, transfers, ATM, payroll, investments, unless they clearly are this category",
  };
}

function repairJsonPayload(raw: string): string {
  return raw.replace(
    /"code"\s*:\s*`([\s\S]*?)`/,
    (_match, code: string) => `"code": ${JSON.stringify(code)}`,
  );
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed
    .replace(/^```(?:json|javascript|js)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const candidates = [fenced];
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(fenced.slice(start, end + 1));
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    for (const payload of [candidate, repairJsonPayload(candidate)]) {
      try {
        return JSON.parse(payload);
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Model did not return JSON");
}

export function indexesInRange(indexes: unknown, length: number): number[] {
  if (!Array.isArray(indexes) || length < 1) return [];
  const picked: number[] = [];
  for (const index of indexes) {
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    if (index < 1 || index > length) continue;
    picked.push(index);
  }
  return picked;
}

async function classifyUnknownMerchants(
  merchants: string[],
  category: SpendCategory,
): Promise<string[]> {
  if (!merchants.length) return [];

  const picked: string[] = [];
  const batchSize = 70;

  for (let offset = 0; offset < merchants.length; offset += batchSize) {
    const batch = merchants.slice(offset, offset + batchSize);
    const catalog = batch
      .map((name, index) => `${index + 1}. ${name}`)
      .join("\n");

    const content = await completeChat([
      {
        role: "system",
        content: `You classify bank merchant strings as ${category.name} or not.
${category.name} = ${category.llmInclude}.
NOT ${category.name} = ${category.llmExclude}.
If unsure, do NOT include it.
Return ONLY JSON: {"indexes":[1,4]}
indexes are the 1-based catalog numbers that ARE ${category.name}.`,
      },
      {
        role: "user",
        content: `Catalog:\n${catalog}`,
      },
    ]);

    try {
      const parsed = extractJson(content) as {
        indexes?: unknown;
      };
      for (const n of indexesInRange(parsed.indexes, batch.length)) {
        const name = batch[n - 1];
        if (name) picked.push(name);
      }
    } catch (error) {
      console.error("Merchant classification parse failed:", error);
      console.error("Raw model output:", content);
    }
  }

  return picked;
}

function cleanMerchantName(raw: string): string {
  let text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text || isBlankMerchant(text)) return "Unknown merchant";

  const upper = text.toUpperCase();
  if (
    upper.includes("AMAZON WEB") ||
    upper.includes("AWS.AMAZON") ||
    /(^|[^A-Z0-9])AWS([^A-Z0-9]|$)/.test(upper)
  ) {
    return "Amazon Web Services";
  }
  if (upper.includes("PLANET HOME")) return "Planet Home";
  if (upper.includes("DUKE") && upper.includes("ENERGY")) return "Duke Energy";
  if (upper.includes("TOWN OF GARNER")) return "Town of Garner";
  if (
    upper.includes("PIEDMONT") &&
    (upper.includes("GAS") || upper.includes("NATURAL"))
  ) {
    return "Piedmont Natural Gas";
  }
  if (upper.includes("ATT*") || upper.includes("AT&T")) return "AT&T";
  if (upper.includes("BLUE CROSS") || upper.includes("BLUE SHIELD")) {
    return "Blue Cross Blue Shield";
  }
  if (upper.includes("COSTCO")) return "Costco";
  if (
    upper.includes("WALMART") ||
    upper.includes("WAL-MART") ||
    upper.includes("WM SUPERCENTER")
  ) {
    return "Walmart";
  }
  if (upper.includes("TRADER JOE")) return "Trader Joe's";
  if (upper.includes("FOOD LION")) return "Food Lion";
  if (upper.includes("TARGET")) return "Target";
  if (upper.includes("PUBLIX")) return "Publix";

  text = text.replace(
    /^(DIRECT DEBIT|DEBIT CARD PURCHASE|ELECTRONIC WITHDRAWAL(?: REQUESTED BY YOU(?: TO)?)?|POS DEBIT|VISA DEBIT|PURCHASE AUTHORIZED ON \d{1,2}\/\d{1,2}|ACH (?:DEBIT|WITHDRAWAL)|CHECKCARD)\s+/i,
    "",
  );
  text = text.replace(/\s*AUTHID:\S+/gi, "");
  text = text.replace(/\s*\([^)]*\)\s*$/g, "");

  const tokens = text.split(" ");
  const kept: string[] = [];
  for (const token of tokens) {
    if (/^#?\d+$/.test(token)) break;
    if (/^[A-Z]\d+$/i.test(token) && kept.length) break;
    if (US_STATE_CODES.has(token.toUpperCase()) && kept.length) break;
    kept.push(token);
  }

  const cleaned = kept.join(" ").replace(/\s+/g, " ").trim();
  return cleaned || text || "Unknown merchant";
}

function formatCurrency(value: number): string {
  return `$${Math.abs(value).toFixed(2)}`;
}

type NormalizedTx = {
  date: string;
  merchant: string;
  amount: number;
  raw: Record<string, string>;
};

type QueryOp =
  | { type: "max" }
  | { type: "min" }
  | { type: "sum" }
  | { type: "avg" }
  | { type: "count" }
  | { type: "top"; n: number }
  | { type: "latest" }
  | { type: "deposit_max" };

function usesSignedAmounts(
  rows: Record<string, string>[],
  amountKey: string | undefined,
): boolean {
  if (!amountKey) return false;
  return rows.some((row) => parseAmount(row[amountKey]) < 0);
}

function isMoneyOut(amount: number, signed: boolean): boolean {
  return signed ? amount < 0 : amount > 0;
}

function isMoneyIn(amount: number, signed: boolean): boolean {
  return signed ? amount > 0 : false;
}

function toNormalizedTx(
  row: Record<string, string>,
  displayFields: ReturnType<typeof pickDisplayFields>,
): NormalizedTx {
  const merchantField = displayFields.description ?? "";
  return {
    date: displayFields.date ? String(row[displayFields.date] ?? "") : "",
    merchant: cleanMerchantName(
      merchantField ? rowNarrative(row, merchantField) : "",
    ),
    amount: parseAmount(
      displayFields.amount ? row[displayFields.amount] : undefined,
    ),
    raw: row,
  };
}

function usableTransactions(
  rows: Record<string, string>[],
  displayFields: ReturnType<typeof pickDisplayFields>,
): NormalizedTx[] {
  return rows
    .map((row) => toNormalizedTx(row, displayFields))
    .filter(
      (tx) => tx.amount !== 0 && tx.merchant !== "Unknown merchant",
    );
}

function detectQueryOp(question: string): QueryOp | undefined {
  const q = question.toLowerCase();
  const top = q.match(/\btop\s+(\d+)\b/);
  if (top) {
    const n = Number(top[1]);
    if (Number.isFinite(n) && n > 0) return { type: "top", n: Math.min(n, 25) };
  }
  if (
    /\b(highest|largest|biggest|most expensive|max(?:imum)?)\b/.test(q) &&
    /\b(deposit|income|credit|refund)\b/.test(q)
  ) {
    return { type: "deposit_max" };
  }
  if (
    /\b(highest|largest|biggest|most expensive|max(?:imum)?)\b/.test(q)
  ) {
    return { type: "max" };
  }
  if (/\b(lowest|smallest|cheapest|min(?:imum)?)\b/.test(q)) {
    return { type: "min" };
  }
  if (/\b(average|avg|mean)\b/.test(q)) return { type: "avg" };
  if (/\b(how many|number of|count of)\b/.test(q)) return { type: "count" };
  if (
    /\b(latest|most recent|last (?:charge|transaction|purchase|payment))\b/.test(
      q,
    )
  ) {
    return { type: "latest" };
  }
  if (
    /\b(total|how much did i spend|how much have i spent|what did i spend)\b/.test(
      q,
    ) &&
    !findSpendCategory(question)
  ) {
    return { type: "sum" };
  }
  return undefined;
}

function applyQueryOp(
  txs: NormalizedTx[],
  op: QueryOp,
  signed: boolean,
): NormalizedTx[] {
  const charges = txs.filter((tx) => isMoneyOut(tx.amount, signed));
  const deposits = txs.filter((tx) => isMoneyIn(tx.amount, signed));

  const byAbsDesc = (a: NormalizedTx, b: NormalizedTx) =>
    Math.abs(b.amount) - Math.abs(a.amount);

  switch (op.type) {
    case "max": {
      if (!charges.length) return [];
      const peak = Math.max(...charges.map((tx) => Math.abs(tx.amount)));
      return charges.filter((tx) => Math.abs(tx.amount) === peak);
    }
    case "min": {
      if (!charges.length) return [];
      const floor = Math.min(...charges.map((tx) => Math.abs(tx.amount)));
      return charges.filter((tx) => Math.abs(tx.amount) === floor);
    }
    case "deposit_max": {
      if (!deposits.length) return [];
      const peak = Math.max(...deposits.map((tx) => Math.abs(tx.amount)));
      return deposits.filter((tx) => Math.abs(tx.amount) === peak);
    }
    case "top":
      return [...charges].sort(byAbsDesc).slice(0, op.n);
    case "latest":
      return [...txs].sort(
        (a, b) => Date.parse(b.date) - Date.parse(a.date) || 0,
      ).slice(0, 1);
    case "sum":
    case "avg":
    case "count":
      return charges;
    default:
      return txs;
  }
}

function formatAggregate(
  rows: NormalizedTx[],
  op: QueryOp,
): string | undefined {
  if (op.type === "count") {
    return `${rows.length} transaction${rows.length === 1 ? "" : "s"}`;
  }
  if (op.type === "avg") {
    if (!rows.length) return "Average: $0.00";
    const total = rows.reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
    return `Average: ${formatCurrency(total / rows.length)} across ${rows.length} charges`;
  }
  return undefined;
}

async function answerFromLedger(
  question: string,
  txs: NormalizedTx[],
): Promise<NormalizedTx[]> {
  if (!txs.length) return [];

  const catalog = txs
    .slice(0, 400)
    .map(
      (tx, index) =>
        `${index + 1}. ${tx.date} | ${tx.merchant} | ${tx.amount.toFixed(2)}`,
    )
    .join("\n");

  const content = await completeChat([
    {
      role: "system",
      content: `You answer questions about a cash-management ledger.
Use ONLY the listed transactions. Spending/charges are usually negative; deposits are usually positive.
Never write code. Never invent rows.
Return ONLY JSON: {"indexes":[1,4]}
indexes are 1-based catalog numbers that answer the question.
For a single transaction (highest, a named merchant, latest), return one index.
For a set (all Chipotle, all last week), return every matching index.
If nothing matches, {"indexes":[]}`,
    },
    {
      role: "user",
      content: `Question: ${question}\n\nLedger:\n${catalog}`,
    },
  ]);

  const parsed = extractJson(content) as {
    indexes?: unknown;
  };
  const picked: NormalizedTx[] = [];
  for (const n of indexesInRange(parsed.indexes, txs.length)) {
    const tx = txs[n - 1];
    if (tx) picked.push(tx);
  }
  return picked;
}

function formatMatches(
  rows: Record<string, string>[],
  displayFields: ReturnType<typeof pickDisplayFields>,
): string {
  if (!rows.length) {
    return "No matching charges located.";
  }

  const lines: string[] = [];
  let totalSum = 0;
  for (const item of rows) {
    const rawName = displayFields.description
      ? rowNarrative(item, displayFields.description) ||
        item[displayFields.description]
      : "";
    const merchant = cleanMerchantName(rawName);
    const amt = parseAmount(
      displayFields.amount ? item[displayFields.amount] : undefined,
    );
    totalSum += amt;
    lines.push(`${merchant}: ${formatCurrency(amt)}`);
  }
  lines.push("");
  lines.push(`Total: ${formatCurrency(totalSum)}`);
  return lines.join("\n");
}

export function parseCsv(rawCsv: string): Promise<Record<string, string>[]> {
  const skipLines = countCsvSkipLines(rawCsv);
  const results: Record<string, string>[] = [];
  return new Promise((resolve, reject) => {
    Readable.from([rawCsv])
      .pipe(
        csv({
          skipLines,
          mapHeaders: ({ header }) => header.replace(/^\uFEFF/, "").trim(),
        }),
      )
      .on("data", (data) => results.push(normalizeRow(data)))
      .on("end", () => resolve(results))
      .on("error", reject);
  });
}

app.post(
  "/api/upload",
  upload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    try {
      let rawCsv: string;
      if (req.file.buffer) {
        rawCsv = req.file.buffer.toString("utf8");
      } else if (req.file.path) {
        // Windows file streams require clean absolute system string references
        const targetPath = path.resolve(req.file.path);
        rawCsv = fs.readFileSync(targetPath, "utf8");
        try {
          fs.unlinkSync(targetPath);
        } catch (err) {
          console.error("File lock warning on Windows: ", err);
        }
      } else {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }

      const rows = await parseCsv(rawCsv);
      if (rows.length > MAX_LEDGER_ROWS) {
        res.status(413).json({
          error: `Statement has ${rows.length} rows. The limit is ${MAX_LEDGER_ROWS}.`,
        });
        return;
      }
      await writeLedger(rows, res.locals.access);
      const fields = rows[0] ? Object.keys(rows[0]) : [];
      const displayFields = rows.length ? pickDisplayFields(rows) : null;
      const columns = fields.map((field) => columnStats(rows, field));
      console.log("Upload schema:", { fields, displayFields, columns });
      res.json({
        message: "Data ingested successfully!",
        count: rows.length,
        fields,
        mappedFields: displayFields,
        columns,
        sampleRows: rows.slice(0, 3),
        sampleMerchants: displayFields?.description
          ? uniqueMerchants(rows, displayFields.description, 15)
          : [],
      });
    } catch (error) {
      console.error("Upload parse failed:", error);
      res.status(500).json({ error: "Failed to read the uploaded report." });
    }
  },
);

app.post("/api/query", async (req: Request, res: Response): Promise<any> => {
  const { question } = req.body;
  const transactionData = await readLedger(res.locals.access);
  if (!transactionData.length) {
    return res
      .status(400)
      .json({ error: "Please upload a transaction report first." });
  }

  const sampleRow = transactionData[0] ?? {};
  const fieldNames = Object.keys(sampleRow);
  const displayFields = pickDisplayFields(transactionData);
  const descriptionField =
    displayFields.description ?? fieldNames[0] ?? "Description";
  const merchants = uniqueMerchants(transactionData, descriptionField);
  const columns = fieldNames.map((field) =>
    columnStats(transactionData, field),
  );

  try {
    const asked = String(question ?? "");
    const queryOp = detectQueryOp(asked);
    const signed = usesSignedAmounts(transactionData, displayFields.amount);
    const allTxs = usableTransactions(transactionData, displayFields);
    const askedMerchant = findAskedMerchant(asked, allTxs);

    let scoped: NormalizedTx[] = allTxs;
    let spendCategory = askedMerchant ? undefined : findSpendCategory(asked);

    if (askedMerchant) {
      const compactName = compactMerchant(askedMerchant.name);
      scoped = allTxs.filter((tx) => {
        const text = `${rowNarrative(tx.raw, descriptionField)} ${tx.merchant}`;
        if (containsAny(text, askedMerchant.tokens)) return true;
        if (compactName.length <= 3) return containsToken(text, compactName);
        return compactName.length >= 4 && compactMerchant(text).includes(compactName);
      });
    } else if (spendCategory) {
      const keywordHits = merchants.filter((name) => {
        const upper = name.toUpperCase();
        return (
          !containsAny(upper, spendCategory.excludeTokens) &&
          containsAny(upper, spendCategory.keywords)
        );
      });
      const unknown = merchants.filter((name) => {
        const upper = name.toUpperCase();
        return (
          !containsAny(upper, spendCategory.excludeTokens) &&
          !containsAny(upper, spendCategory.keywords)
        );
      });

      const llmHits = (
        await classifyUnknownMerchants(unknown, spendCategory)
      ).filter((name) => !containsAny(name, spendCategory.excludeTokens));
      const includeNames = [...new Set([...keywordHits, ...llmHits])].filter(
        (name) =>
          (isUsefulIncludeToken(name) ||
            containsAny(name, spendCategory.keywords)) &&
          !containsAny(name, spendCategory.excludeTokens),
      );

      console.log(`${spendCategory.name} classify:`, {
        descriptionField,
        merchantCount: merchants.length,
        columns,
        sampleRows: transactionData.slice(0, 3),
        keywordHits,
        llmHits,
        includeNames,
      });

      scoped = allTxs.filter((tx) => {
        const text = rowNarrative(tx.raw, descriptionField);
        if (!text) return false;
        if (containsAny(text, spendCategory.excludeTokens)) return false;
        if (containsAny(text, spendCategory.keywords)) return true;
        return includeNames.some((name) => text.includes(name.toUpperCase()));
      });
    }

    if (queryOp) {
      const selected = applyQueryOp(scoped, queryOp, signed);
      const aggregate = formatAggregate(selected, queryOp);
      if (aggregate && (queryOp.type === "count" || queryOp.type === "avg")) {
        return res.json({ answer: aggregate });
      }
      return res.json({
        answer: formatMatches(
          selected.map((tx) => tx.raw),
          displayFields,
        ),
      });
    }

    if (spendCategory || askedMerchant) {
      return res.json({
        answer: formatMatches(
          scoped.map((tx) => tx.raw),
          displayFields,
        ),
      });
    }

    const picked = await answerFromLedger(asked, allTxs);
    return res.json({
      answer: formatMatches(
        picked.map((tx) => tx.raw),
        displayFields,
      ),
    });
  } catch (error) {
    console.error("Agent Execution Bug: ", error);
    res
      .status(500)
      .json({ error: "Failed to process financial array accurately." });
  }
});

app.get("/api/report", async (_req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  try {
    res.json(await reportFor(res.locals.access));
  } catch (error) {
    console.error("Report lookup failed:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

app.get("/api/health", (_req: Request, res: Response) => {
  const provider = llmProvider();
  res.json({
    ok: true,
    runtime: onWorkers() ? "cloudflare-workers" : "node",
    llm: provider,
    model: provider === "workers-ai" ? workersAiModel() : ollamaModel(),
    ledger: onWorkers() ? "durable-object" : "memory",
  });
});

app.use(
  (
    error: unknown,
    _req: Request,
    res: Response,
    next: (error?: unknown) => void,
  ) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "File is larger than 5 MB." });
      return;
    }
    next(error);
  },
);

app.use((error: unknown, _req: Request, res: Response, _next: (error?: unknown) => void) => {
  console.error("Request failed:", error instanceof Error ? error.message : "unknown error");
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error." });
});

export { app };

const entry = process.argv[1];
const isNodeEntry = !!entry && !!__filename && path.resolve(entry) === __filename;

if (isNodeEntry) {
  const port = Number(process.env.PORT ?? PORT);
  app.listen(port, () =>
    console.log(`Backend active on http://localhost:${port}`),
  );
}
