import {
  CATEGORIES,
  isCategory,
  tokenIn,
  type Category,
} from "./categories.js";
import { extractJson } from "./json-text.js";
import type { ChatTurn } from "./llm.js";
import { formatSignedCents, isIsoDate } from "./statement.js";

export type QueryOp = "sum" | "list" | "max" | "count";
export type QueryScope = "all-spending" | "filtered";
export type QueryCombine = "or" | "and";

export type QueryIntent = {
  categories: Category[];
  merchants: string[];
  excludeMerchants: string[];
  dateFrom: string | null;
  dateTo: string | null;
  op: QueryOp;
  combine: QueryCombine;
  scope: QueryScope;
};

export type TxView = {
  date: string;
  merchant: string;
  narrative: string;
  amountCents: number;
  // Positive means money left the account. A refund on a signed statement is negative.
  spendCents: number;
  category: Category;
};

export type Interpreted = {
  intent: QueryIntent;
  confident: boolean;
  followUp: boolean;
  unrecognized: boolean;
  invalidDateRange: boolean;
  invalidCalendarDate: boolean;
  // The question says "since" but code could not place the date.
  unplacedSince?: boolean;
};

const OPS = new Set<QueryOp>(["sum", "list", "max", "count"]);

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const STOP_WORDS = new Set([
  "how", "much", "many", "did", "does", "do", "spent", "spend", "spending",
  "charge", "charges", "transaction", "transactions", "purchase", "purchases",
  "payment", "payments", "total", "show", "list", "all", "and", "the", "for",
  "you", "can", "what", "was", "were", "highest", "largest", "biggest", "most",
  "expensive", "maximum", "max", "count", "number", "from", "last", "this",
  "that", "with", "please", "tell", "about", "during", "between", "have",
  "has", "had", "out", "eating", "eat", "my", "me", "not", "food", "a", "an",
  "of", "to", "in", "on", "it", "at", "or", "just", "only", "also", "them",
  "those", "these", "is", "isn", "wasn", "aren", "don", "exclude", "except",
  "without", "remove", "include", "located", "matching", "your", "i",
  "since",
]);

const MERCHANT_TOKEN_SKIP = new Set([
  ...STOP_WORDS,
  "debit", "card", "purchase", "direct", "deposit", "payment", "charge",
  "transfer", "visa", "withdrawal", "electronic", "pending", "auth", "plan",
  "solo", "com", "inc", "gas", "food", "foods", "store", "market", "online",
  "bill", "bills", "pos", "ach", "web", "services", "service", "sq", "www",
]);

const COFFEE_NEEDLES = ["coffee", "starbucks", "dunkin", "dutch bros", "peet"];

const CATEGORY_PATTERNS: { category: Category; pattern: RegExp }[] = [
  {
    category: "dining",
    pattern:
      /\b(eat(?:ing)? out|dining|restaurants?|fast food|take-?out|takeout|food delivery)\b/i,
  },
  { category: "groceries", pattern: /\b(grocer(?:y|ies)|supermarket)\b/i },
  {
    category: "shopping",
    pattern: /\b(shopping|clothes|clothing|retail|general merchandise|merchandise)\b/i,
  },
  {
    category: "entertainment/events",
    pattern: /\b(entertainment|events?|tickets|concerts?)\b/i,
  },
  {
    category: "subscriptions",
    pattern: /\b(subscriptions?|streaming|memberships?)\b/i,
  },
  {
    category: "utilities/telecom",
    pattern:
      /\b(utilities|utility|electric|telecom|internet|natural gas|gas bill|bills|water bill|sewer bill)\b/i,
  },
  {
    category: "insurance/auto",
    pattern: /\b((?:car|auto|vehicle)\s+insurance)\b/i,
  },
  {
    category: "insurance/health",
    pattern: /\b((?:health|medical)\s+insurance|insurance)\b/i,
  },
  {
    category: "healthcare",
    pattern:
      /\b(healthcare|health care|medical(?!\s+insurance)|doctor|dentist|pharmacy|hospital)\b/i,
  },
  { category: "transfers", pattern: /\b(transfers?|zelle|venmo|wire)\b/i },
  {
    category: "credit-cards",
    pattern: /\b(credit\s*cards?|credit[- ]card payments?|card payments?)\b/i,
  },
  {
    category: "income",
    pattern:
      /\b(income|paycheck|paychecks|payroll|salary|direct deposit|wages?)\b/i,
  },
  {
    category: "cloud/software",
    pattern: /\b(cloud|aws|software)\b/i,
  },
  {
    category: "home",
    pattern: /\b(home improvement|hardware|household|hvac)\b/i,
  },
  {
    category: "housing/mortgage",
    pattern: /\b(mortgage|mortgages|home loan|housing)\b/i,
  },
];

function escapeReg(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripPattern(text: string, pattern: RegExp): string {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return text.replace(new RegExp(pattern.source, flags), " ");
}

function asStringList(value: unknown, maxItems: number, maxLen: number): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxLen) return null;
    if (!out.some((existing) => existing.toUpperCase() === trimmed.toUpperCase())) {
      out.push(trimmed);
    }
  }
  return out;
}

function asDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !isIsoDate(value)) return undefined;
  return value;
}

// Model output and stored intent both come through here. `stored` keeps a
// filtered scope that no longer has categories (income stripped, match nothing).
export function validateIntent(
  input: unknown,
  source: "model" | "stored" = "model",
): QueryIntent | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if ("indexes" in record && !("op" in record)) return null;
  if (typeof record.op !== "string" || !OPS.has(record.op as QueryOp)) return null;

  if (!Array.isArray(record.categories)) return null;
  const categories: Category[] = [];
  for (const category of record.categories) {
    if (typeof category !== "string" || !isCategory(category)) return null;
    if (!categories.includes(category)) categories.push(category);
  }

  const merchants = asStringList(record.merchants ?? [], 20, 80);
  const excludeMerchants = asStringList(record.excludeMerchants ?? [], 20, 120);
  if (!merchants || !excludeMerchants) return null;

  const dateFrom = asDate(record.dateFrom);
  const dateTo = asDate(record.dateTo);
  if (dateFrom === undefined || dateTo === undefined) return null;
  if (dateFrom && dateTo && dateFrom > dateTo) return null;

  let combine: QueryCombine = "or";
  if (record.combine !== undefined) {
    if (record.combine !== "or" && record.combine !== "and") return null;
    combine = record.combine;
  }

  let scope: QueryScope;
  if (categories.length || merchants.length) scope = "filtered";
  else if (source === "stored" && record.scope === "filtered") scope = "filtered";
  else scope = "all-spending";

  return {
    categories,
    merchants,
    excludeMerchants,
    dateFrom,
    dateTo,
    op: record.op as QueryOp,
    combine,
    scope,
  };
}

export function intentFromModel(raw: string, question: string): QueryIntent | null {
  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch {
    return null;
  }
  const intent = validateIntent(parsed, "model");
  if (!intent) return null;
  return applyQuestionGuards(intent, question, true);
}

function asksForIncome(topic: string): boolean {
  return /\b(income|paycheck|paychecks|payroll|salary|direct deposit|wages?)\b/i.test(
    topic,
  );
}

function asksForTransfers(topic: string): boolean {
  return /\b(transfers?|zelle|venmo|paypal|wire)\b/i.test(topic);
}

function asksForCreditCards(topic: string): boolean {
  return /\b(credit\s*cards?|credit[- ]card payments?|card payments?)\b/i.test(topic);
}

function isNonSpendingCategory(category: Category): boolean {
  return category === "income" || category === "transfers" || category === "credit-cards";
}

export function applyQuestionGuards(
  intent: QueryIntent,
  question: string,
  allowExpand: boolean,
): QueryIntent {
  const topic = question.split(":")[0] ?? question;
  const income = asksForIncome(topic);
  const transfers = asksForTransfers(topic);
  const creditCards = asksForCreditCards(topic);
  let categories = intent.categories.filter((category) => {
    if (category === "income") return income;
    if (category === "transfers") return transfers;
    if (category === "credit-cards") return creditCards;
    return true;
  });
  if (allowExpand && income && !categories.includes("income")) {
    categories = [...categories, "income"];
  }
  if (allowExpand && transfers && !categories.includes("transfers")) {
    categories = [...categories, "transfers"];
  }
  if (allowExpand && creditCards && !categories.includes("credit-cards")) {
    categories = [...categories, "credit-cards"];
  }
  // A question that names categories uses those categories. "dining and bills"
  // keeps both. A follow-up that only names the new topic replaces the old
  // list, because that list is not part of this question. A correction
  // ("exclude chipotle") keeps the previous categories.
  if (!isCorrection(topic)) {
    const named = categoriesNamedIn(topic);
    if (named.length) categories = named;
  }
  const strippedAll =
    intent.categories.length > 0 &&
    categories.length === 0 &&
    intent.merchants.length === 0;
  let scope: QueryScope = intent.scope;
  if (categories.length || intent.merchants.length) scope = "filtered";
  else if (strippedAll) scope = "filtered";
  return { ...intent, categories, scope };
}

export function textHasMerchant(text: string, needle: string): boolean {
  return tokenIn(text, needle);
}

function isExcluded(tx: TxView, needles: string[]): boolean {
  const hay = `${tx.narrative} ${tx.merchant}`;
  return needles.some((needle) => tokenIn(hay, needle, true));
}

function nonSpendingOnly(intent: QueryIntent): boolean {
  return (
    intent.categories.length > 0 &&
    intent.categories.every((category) => isNonSpendingCategory(category))
  );
}

function lineCents(tx: TxView, intent: QueryIntent): number {
  if (nonSpendingOnly(intent)) return Math.abs(tx.amountCents);
  return tx.spendCents;
}

export function transactionMatches(tx: TxView, intent: QueryIntent): boolean {
  if (
    intent.scope === "filtered" &&
    intent.categories.length === 0 &&
    intent.merchants.length === 0
  ) {
    return false;
  }
  if (isExcluded(tx, intent.excludeMerchants)) return false;
  if (intent.dateFrom && (!tx.date || tx.date < intent.dateFrom)) return false;
  if (intent.dateTo && (!tx.date || tx.date > intent.dateTo)) return false;

  const hay = `${tx.narrative} ${tx.merchant}`;
  const merchantOk = intent.merchants.some((needle) => textHasMerchant(hay, needle));
  const categoryOk = intent.categories.includes(tx.category);
  const nonSpending = isNonSpendingCategory(tx.category);
  if (nonSpending && !categoryOk && !merchantOk) return false;

  if (intent.categories.length && intent.merchants.length) {
    return intent.combine === "and" ? categoryOk && merchantOk : categoryOk || merchantOk;
  }
  if (intent.categories.length) return categoryOk;
  if (intent.merchants.length) return merchantOk;
  return !nonSpending;
}

export function selectTransactions(txs: TxView[], intent: QueryIntent): TxView[] {
  const matched = txs.filter((tx) => transactionMatches(tx, intent));
  if (intent.op !== "max") return matched;
  // Highest charge is the largest money-out. A deposit or refund must not win
  // unless the question is about income or transfers.
  const pool = nonSpendingOnly(intent)
    ? matched
    : matched.filter((tx) => tx.spendCents > 0);
  if (!pool.length) return [];
  const rank = (tx: TxView) =>
    nonSpendingOnly(intent) ? Math.abs(tx.amountCents) : tx.spendCents;
  const peak = Math.max(...pool.map(rank));
  return pool.filter((tx) => rank(tx) === peak);
}

export function totalCents(rows: TxView[], intent?: QueryIntent): number {
  return rows.reduce(
    (sum, row) => sum + (intent ? lineCents(row, intent) : row.spendCents),
    0,
  );
}

export function formatAnswer(rows: TxView[], intent: QueryIntent): string {
  if (!rows.length) {
    if (intent.categories.length === 1 && intent.categories[0] === "insurance/auto") {
      return "No car insurance charges were found.";
    }
    return "No matching charges located.";
  }
  const lines = rows.map(
    (row) => `${row.merchant}: ${formatSignedCents(lineCents(row, intent))}`,
  );
  lines.push("");
  lines.push(`Total: ${formatSignedCents(totalCents(rows, intent))}`);
  if (intent.op === "count") lines.push(`Count: ${rows.length}`);
  return lines.join("\n");
}

function clauseBeforeColon(question: string): string {
  const index = question.indexOf(":");
  return index >= 0 ? question.slice(0, index) : question;
}

function isCorrection(question: string): boolean {
  return /\b(not a|is not|isn'?t|was not|wasn'?t|exclude|except|without|remove|don'?t include|do not include|that(?:'s| is) not)\b/i.test(
    question,
  );
}

function hasNewTopic(question: string): boolean {
  const clause = clauseBeforeColon(question);
  if (CATEGORY_PATTERNS.some((entry) => entry.pattern.test(clause))) return true;
  if (/\b(gas|gasoline|fuel|coffee|starbucks|dunkin)\b/i.test(clause)) return true;
  if (/\b(paypal|zelle|venmo|aws|netflix)\b/i.test(clause)) return true;
  return false;
}

export function isPureFollowUp(
  question: string,
  previous: QueryIntent | null,
): boolean {
  return !!previous && isCorrection(question) && !hasNewTopic(question);
}

function distinctiveTokens(name: string): string[] {
  const tokens = name.toUpperCase().split(/[^A-Z0-9]+/);
  const out: string[] = [];
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (/^\d+$/.test(token)) continue;
    if (MERCHANT_TOKEN_SKIP.has(token.toLowerCase())) continue;
    out.push(token);
  }
  return out;
}

function mentionedMerchants(question: string, known: string[]): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const name of known) {
    for (const token of distinctiveTokens(name)) {
      if (seen.has(token)) continue;
      if (!tokenIn(question, token, true)) continue;
      seen.add(token);
      hits.push(token);
    }
  }
  return hits;
}

function colonMerchant(question: string): string | null {
  const parts = question
    .split(":")
    .slice(1)
    .map((part) => part.replace(/\$[\d,.]+/g, "").replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 4);
  parts.sort((a, b) => b.length - a.length);
  return parts[0] ?? null;
}

function exclusionTerms(question: string, known: string[]): string[] {
  if (!isCorrection(question)) return [];
  const terms = mentionedMerchants(question, known);
  const colon = colonMerchant(question);
  if (colon) terms.push(colon);
  return dedupe(terms);
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (out.some((item) => item.toUpperCase() === trimmed.toUpperCase())) continue;
    out.push(trimmed);
  }
  return out;
}

function pushCategory(categories: Category[], category: Category): void {
  if (!categories.includes(category)) categories.push(category);
}

function categoriesNamedIn(topic: string): Category[] {
  const named: Category[] = [];
  const carInsurance = /\b(?:car|auto|vehicle)\s+insurance\b/i.test(topic);
  for (const entry of CATEGORY_PATTERNS) {
    if (carInsurance && entry.category === "insurance/health") continue;
    if (entry.pattern.test(topic)) pushCategory(named, entry.category);
  }
  const naturalGas = /\b(natural gas|gas bill)\b/i.test(topic);
  if (!naturalGas && /\b(gas|gasoline|fuel)\b/i.test(topic)) {
    pushCategory(named, "gas/auto");
  }
  return named;
}

function monthRange(question: string): { from: string; to: string } | null {
  const match = question.match(
    new RegExp(`\\b(${MONTHS.join("|")})\\s+(20\\d{2})\\b`, "i"),
  );
  if (!match?.[1] || !match[2]) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase()) + 1;
  const year = Number(match[2]);
  if (!month || !Number.isInteger(year)) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, "0");
  return {
    from: `${year}-${mm}-01`,
    to: `${year}-${mm}-${String(last).padStart(2, "0")}`,
  };
}

// "since March", "since March 15", "since March 2026", "since March 15, 2026",
// or "since 2026-03-01" is open-ended. A month (and day) without a year is the
// latest such date on or before the ledger's last date. Without a ledger date,
// or with a day that is not on the calendar, it is left to the model.
function sinceDate(question: string, latestDate: string | null): string | null {
  const iso = question.match(/\bsince\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (iso?.[1]) return iso[1];
  const named = question.match(
    new RegExp(
      `\\bsince\\s+(${MONTHS.join("|")})(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?(?:,?\\s+(20\\d{2}))?\\b`,
      "i",
    ),
  );
  if (!named?.[1]) return null;
  const month = MONTHS.indexOf(named[1].toLowerCase()) + 1;
  if (!month) return null;
  const day = named[2] ? Number(named[2]) : 1;
  const mmdd = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  let year: number;
  if (named[3]) {
    year = Number(named[3]);
  } else {
    const latest = latestDate?.match(/^(\d{4})-\d{2}-\d{2}$/);
    if (!latest?.[1] || !latestDate) return null;
    year = Number(latest[1]);
    if (`${year}-${mmdd}` > latestDate) year -= 1;
  }
  if (!Number.isInteger(year)) return null;
  const value = `${year}-${mmdd}`;
  return isIsoDate(value) ? value : null;
}

function dateRange(question: string, latestDate: string | null = null): {
  from: string | null;
  to: string | null;
  invalid: boolean;
  calendar: boolean;
} {
  const tokens = [...question.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map(
    (match) => match[1] ?? "",
  );
  // An explicit ISO token that is not a real day must not be dropped. Dropping
  // it widens a single date to the whole ledger, or narrows a range to the
  // one endpoint that happened to be valid.
  if (tokens.some((token) => !isIsoDate(token))) {
    return { from: null, to: null, invalid: true, calendar: true };
  }
  const since = tokens.length <= 1 ? sinceDate(question, latestDate) : null;
  if (since) return { from: since, to: null, invalid: false, calendar: false };
  if (tokens.length >= 2) {
    const from = tokens[0] ?? null;
    const to = tokens[tokens.length - 1] ?? null;
    if (from && to && from > to) {
      return { from: null, to: null, invalid: true, calendar: false };
    }
    return { from, to, invalid: false, calendar: false };
  }
  if (tokens.length === 1) {
    return { from: tokens[0] ?? null, to: tokens[0] ?? null, invalid: false, calendar: false };
  }
  const month = monthRange(question);
  if (month) return { from: month.from, to: month.to, invalid: false, calendar: false };
  return { from: null, to: null, invalid: false, calendar: false };
}

function detectOp(question: string, hasFilter: boolean): QueryOp | null {
  if (/\b(highest|largest|biggest|most expensive|max(?:imum)?)\b/i.test(question)) {
    return "max";
  }
  if (/\b(how many|number of|count)\b/i.test(question)) return "count";
  if (/\b(list|show me|what are|which charges|which transactions)\b/i.test(question)) {
    return "list";
  }
  if (
    hasFilter ||
    /\b(how much|total|spent|spend|spending|sum)\b/i.test(question)
  ) {
    return "sum";
  }
  return null;
}

function unrecognizedTopic(question: string, consumedTokens: string[]): boolean {
  let text = question.toLowerCase();
  for (const entry of CATEGORY_PATTERNS) text = stripPattern(text, entry.pattern);
  text = stripPattern(text, /\b(gas|gasoline|fuel|coffee|starbucks|dunkin|paypal|aws|netflix)\b/i);
  text = stripPattern(text, /\b20\d{2}-\d{2}-\d{2}\b/);
  text = stripPattern(
    text,
    new RegExp(
      `\\b(${MONTHS.join("|")})(\\s+\\d{1,2}(st|nd|rd|th)?)?(,?\\s+20\\d{2})?\\b`,
      "i",
    ),
  );
  text = text.replace(/\$[\d,.]+/g, " ");
  for (const token of consumedTokens) text = stripPattern(text, new RegExp(`\\b${escapeReg(token)}\\b`, "i"));
  const words = text.split(/[^a-z0-9]+/).filter((word) => word.length > 2);
  return words.some((word) => !STOP_WORDS.has(word));
}

function blankIntent(op: QueryOp): QueryIntent {
  return {
    categories: [],
    merchants: [],
    excludeMerchants: [],
    dateFrom: null,
    dateTo: null,
    op,
    combine: "or",
    scope: "all-spending",
  };
}

export function interpretQuestion(
  question: string,
  previous: QueryIntent | null,
  knownMerchants: string[],
  latestDate: string | null = null,
): Interpreted | null {
  const asked = question.trim();
  if (!asked) return null;

  const dates = dateRange(asked, latestDate);
  if (dates.invalid) {
    return {
      intent: blankIntent("sum"),
      confident: false,
      followUp: false,
      unrecognized: false,
      invalidDateRange: !dates.calendar,
      invalidCalendarDate: dates.calendar,
    };
  }

  if (isPureFollowUp(asked, previous) && previous) {
    const excludeMerchants = dedupe([
      ...previous.excludeMerchants,
      ...exclusionTerms(asked, knownMerchants),
    ]);
    const intent = applyQuestionGuards(
      { ...previous, excludeMerchants },
      asked,
      false,
    );
    return {
      intent,
      confident: true,
      followUp: true,
      unrecognized: false,
      invalidDateRange: false,
      invalidCalendarDate: false,
    };
  }

  const categories: Category[] = [];
  for (const entry of CATEGORY_PATTERNS) {
    if (entry.pattern.test(asked)) pushCategory(categories, entry.category);
  }
  const naturalGas = /\b(natural gas|gas bill)\b/i.test(asked);
  if (!naturalGas && /\b(gas|gasoline|fuel)\b/i.test(asked)) {
    pushCategory(categories, "gas/auto");
  }

  const merchants: string[] = [];
  if (/\b(coffee|starbucks|dunkin)\b/i.test(asked)) merchants.push(...COFFEE_NEEDLES);
  if (/\bpaypal\b/i.test(asked)) merchants.push("paypal");
  if (/\bnetflix\b/i.test(asked)) merchants.push("netflix");
  if (/\batt\b/i.test(asked)) merchants.push("att");
  for (const token of mentionedMerchants(asked, knownMerchants)) {
    if (!merchants.some((item) => item.toUpperCase() === token.toUpperCase())) {
      merchants.push(token);
    }
  }

  const exclusions = exclusionTerms(asked, knownMerchants);
  const hasFilter = categories.length > 0 || merchants.length > 0;
  const op = detectOp(asked, hasFilter);
  if (!op && !hasFilter && !exclusions.length) return null;

  const combine: QueryCombine =
    categories.length &&
    merchants.length &&
    /\b(at|from)\b/i.test(asked) &&
    !/\b(and|or)\b/i.test(asked)
      ? "and"
      : "or";

  const intent = applyQuestionGuards(
    {
      ...blankIntent(op ?? "sum"),
      categories,
      merchants: dedupe(merchants),
      excludeMerchants: exclusions,
      dateFrom: dates.from,
      dateTo: dates.to,
      combine,
      scope: hasFilter ? "filtered" : "all-spending",
    },
    asked,
    true,
  );
  // "since" with no date we could place must not quietly mean the whole ledger.
  const unplacedSince = /\bsince\b/i.test(asked) && !dates.from;
  const unrecognized = unplacedSince || unrecognizedTopic(asked, merchants);
  const confident = !unrecognized && (!!op || hasFilter);
  return {
    intent,
    confident,
    followUp: false,
    unrecognized,
    invalidDateRange: false,
    invalidCalendarDate: false,
    unplacedSince,
  };
}

export function buildIntentMessages(
  question: string,
  previous: QueryIntent | null,
): ChatTurn[] {
  const previousText = previous
    ? JSON.stringify({
        categories: previous.categories,
        merchants: previous.merchants,
        excludeMerchants: previous.excludeMerchants,
        dateFrom: previous.dateFrom,
        dateTo: previous.dateTo,
        op: previous.op,
        combine: previous.combine,
      })
    : "null";
  return [
    {
      role: "system",
      content: `You parse a personal finance question into JSON. You do not see transactions and you must not calculate a total.
Return ONLY JSON:
{"categories":[],"merchants":[],"excludeMerchants":[],"dateFrom":null,"dateTo":null,"op":"sum","combine":"or"}
categories must be chosen from: ${CATEGORIES.join(", ")}.
op is sum, list, max, or count.
dateFrom and dateTo are YYYY-MM-DD or null.
combine is "or" when any category or merchant should match (gas and coffee). combine is "and" when a merchant narrows a category.
Leave income, transfers, and credit-cards out of categories unless the user asked for income, paychecks, deposits, transfers, PayPal, Zelle, Venmo, or credit-card payments.
A mortgage or housing question is housing/mortgage only. A bills question is utilities/telecom only. Health insurance is insurance/health only, not car insurance. Car insurance is insurance/auto only and does not include credit-card autopay. A credit-card payment question is credit-cards only. Do not answer those with healthcare, home, or another nearby category.
If the user names a new category, replace the previous categories. Keep the previous categories only when the user is excluding or correcting a charge.
If nothing in the list fits, return an empty categories array.
Do not return transaction indexes, code, or rows.
Previous intent: ${previousText}`,
    },
    { role: "user", content: question },
  ];
}
