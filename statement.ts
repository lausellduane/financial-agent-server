import csv from "csv-parser";
import { Readable } from "node:stream";

export type DisplayFields = {
  date: string | undefined;
  description: string;
  amount: string | undefined;
};

export function parseAmountCents(raw: string | undefined): number {
  if (!raw) return 0;
  const trimmed = raw.replace(/[$,\s]/g, "").trim();
  if (!trimmed) return 0;
  const negative = trimmed.startsWith("(") || trimmed.startsWith("-");
  const numeric = trimmed.replace(/[()]/g, "").replace(/^[+-]/, "");
  const match = numeric.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    const value = Number(numeric);
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 100) * (negative ? -1 : 1);
  }
  const dollars = Number(match[1] ?? "0");
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const cents = dollars * 100 + Number(fraction);
  return negative ? -cents : cents;
}

export function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `$${dollars}.${String(rem).padStart(2, "0")}`;
}

export function formatSignedCents(cents: number): string {
  if (cents < 0) return `-${formatCents(cents)}`;
  return formatCents(cents);
}

// Calendar date for the report summary. Invalid calendar dates are dropped.
export function calendarDate(raw: string | undefined): string | undefined {
  const text = String(raw ?? "").trim();
  if (!text) return undefined;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(text);
  let year: number;
  let month: number;
  let day: number;
  if (iso?.[1] && iso[2] && iso[3]) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (us?.[1] && us[2] && us[3]) {
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

export function statementDateRange(rows: Record<string, string>[]): {
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

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split("-").map((part) => Number(part));
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function normalizeDate(raw: string): string {
  const trimmed = raw.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso?.[1] && iso[2] && iso[3]) {
    const value = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return isIsoDate(value) ? value : "";
  }
  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!us?.[1] || !us[2] || !us[3]) return "";
  const year = us[3].length === 2 ? `20${us[3]}` : us[3];
  const value = `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return isIsoDate(value) ? value : "";
}

export function usesSignedCents(
  rows: Record<string, string>[],
  amountKey: string | undefined,
): boolean {
  if (!amountKey) return false;
  return rows.some((row) => parseAmountCents(row[amountKey]) < 0);
}

export function normalizeRow(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    const cleanKey = key.replace(/^\uFEFF/, "").trim();
    out[cleanKey] = value == null ? "" : String(value).trim();
  }
  return out;
}

export function isBlankMerchant(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return /^(no description|n\/?a|none|null|undefined|-|—|--|\.|processing|pending|settled)$/i.test(
    trimmed,
  );
}

function countCsvSkipLines(content: string): number {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const line = (lines[i] ?? "").replace(/^\uFEFF/, "").replace(/"/g, "");
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

export function columnStats(rows: Record<string, string>[], field: string) {
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
  let best =
    keys.find((key) => /desc|action|payee|name|merchant|memo/i.test(key)) ??
    keys[0] ??
    "Description";
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

const DATE_HEADERS = [
  "Date",
  "Run Date",
  "Transaction Date",
  "Trans. Date",
  "Trans Date",
  "Posted Date",
  "Post Date",
  "Posting Date",
];

const AMOUNT_HEADERS = [
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
];

export function pickDisplayFields(rows: Record<string, string>[]): DisplayFields {
  const keys = Object.keys(rows[0] ?? {});
  return {
    date:
      findField(keys, DATE_HEADERS) ?? keys[0],
    description: pickMerchantField(rows),
    amount:
      findField(keys, AMOUNT_HEADERS) ??
      keys.find((key) => /amount/i.test(key)) ??
      keys[2],
  };
}

export function uniqueMerchants(
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

export function rowNarrative(
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

const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "HI",
  "IA", "ID", "IL", "IN", "KS", "KY", "LA", "MA", "MD", "ME", "MI", "MN",
  "MO", "MS", "MT", "NC", "ND", "NE", "NH", "NJ", "NM", "NV", "NY", "OH",
  "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VA", "VT", "WA",
  "WI", "WV", "WY",
]);

export function cleanMerchantName(raw: string): string {
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
      .on("data", (data: Record<string, unknown>) => results.push(normalizeRow(data)))
      .on("end", () => resolve(results))
      .on("error", reject);
  });
}

export type ShapeFields = { fields: DisplayFields; signed: boolean };

// The columns and sign convention one upload was read with. It is saved with
// the upload, so a later file from another bank (even with the same header
// row) cannot change how these rows read.
export type UploadLayout = ShapeFields;

export function uploadLayout(rows: Record<string, string>[]): UploadLayout {
  const fields = pickDisplayFields(rows);
  return { fields, signed: usesSignedCents(rows, fields.amount) };
}

export function parseLayout(raw: string | null | undefined): UploadLayout | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<UploadLayout> | null;
    const fields = value?.fields;
    if (!fields || typeof fields.description !== "string") return null;
    return {
      fields: {
        date: typeof fields.date === "string" ? fields.date : undefined,
        description: fields.description,
        amount: typeof fields.amount === "string" ? fields.amount : undefined,
      },
      signed: value.signed === true,
    };
  } catch {
    return null;
  }
}

export function headerShape(row: Record<string, string>): string {
  return Object.keys(row).join("\u001f");
}

// Only for rows saved before layouts were stored with each upload. Those came
// from one replace-only upload, so a header row stands in for the file.
export function shapeFields(
  rows: Record<string, string>[],
): (row: Record<string, string>) => ShapeFields {
  const groups = new Map<string, Record<string, string>[]>();
  for (const row of rows) {
    const shape = headerShape(row);
    const group = groups.get(shape);
    if (group) group.push(row);
    else groups.set(shape, [row]);
  }
  const resolved = new Map<string, ShapeFields>();
  for (const [shape, group] of groups) resolved.set(shape, uploadLayout(group));
  return (row) => {
    const shape = headerShape(row);
    const found = resolved.get(shape);
    if (found) return found;
    const fallback = uploadLayout([row]);
    resolved.set(shape, fallback);
    return fallback;
  };
}

const MONEY_COLUMN = /amount|amt|debit|credit|withdrawal|deposit/i;
const NOT_TEXT_COLUMN =
  /date|amount|amt|debit|credit|withdrawal|deposit|balance|qty|quantity|price|commission|fees?|account|symbol|type|status|settlement|check ?(number|no)|category/i;

// Header names, in order, for the text part of the duplicate key. Picked from
// the header row only, never from row contents, so a partial re-export or an
// extra Memo column in a later export keys the same charge the same way.
const KEY_TEXT_HEADERS = [
  "Action",
  "Description",
  "Transaction Description",
  "Original Description",
  "Merchant",
  "Merchant Name",
  "Payee",
  "Name",
  "Details",
  "Transaction",
  "Memo",
];

export type KeyFields = {
  date: string | undefined;
  text: string | undefined;
  amount: string | undefined;
};

export function keyFields(keys: string[]): KeyFields {
  const display = pickHeaderFields(keys);
  const exact = new Map(keys.map((key) => [key.toLowerCase(), key]));
  let text: string | undefined;
  for (const name of KEY_TEXT_HEADERS) {
    text = exact.get(name.toLowerCase());
    if (text) break;
  }
  text ??= keys.find(
    (key) =>
      /desc|action|payee|merchant|name|details|transaction|memo/i.test(key) &&
      !NOT_TEXT_COLUMN.test(key),
  );
  text ??= keys.find(
    (key) => key !== display.date && key !== display.amount && !NOT_TEXT_COLUMN.test(key),
  );
  return { date: display.date, text, amount: display.amount };
}

// Date and amount columns are already chosen from header names alone.
function pickHeaderFields(keys: string[]): { date: string | undefined; amount: string | undefined } {
  return {
    date: findField(keys, DATE_HEADERS) ?? keys[0],
    amount: findField(keys, AMOUNT_HEADERS) ?? keys.find((key) => /amount/i.test(key)) ?? keys[2],
  };
}

// One charge's identity: calendar date, the header-picked text column, and
// cents. Parsed values are compared, so "1,541.42" and "1541.42", or 3/1/2026
// and 2026-03-01, match. Two identical charges in one file share this key;
// the ledger keeps as many of them as the fullest upload had (see append).
export function dedupeKey(row: Record<string, string>, fields: KeyFields): string {
  const rawDate = fields.date ? String(row[fields.date] ?? "") : "";
  const date = normalizeDate(rawDate) || rawDate.trim().toUpperCase();
  const text = (fields.text ? String(row[fields.text] ?? "") : "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  const amount = parseAmountCents(fields.amount ? row[fields.amount] : undefined);
  // Split debit/credit exports leave the picked column blank on the other
  // side. Only nonzero values count, so an added empty column changes nothing.
  const otherMoney = Object.keys(row)
    .filter((key) => key !== fields.amount && MONEY_COLUMN.test(key) && !/balance/i.test(key))
    .map((key) => parseAmountCents(row[key]))
    .filter((cents) => cents !== 0)
    .sort((a, b) => a - b);
  return JSON.stringify([date, text, amount, ...otherMoney]);
}

// Each row's key depends only on that row's own headers and values.
export function dedupeKeys(rows: Record<string, string>[]): string[] {
  const byShape = new Map<string, KeyFields>();
  return rows.map((row) => {
    const shape = headerShape(row);
    let fields = byShape.get(shape);
    if (!fields) {
      fields = keyFields(Object.keys(row));
      byShape.set(shape, fields);
    }
    return dedupeKey(row, fields);
  });
}

// Each row's copy number of its key within the file: the first row with a
// key is copy 1, the next row with the same key is copy 2, and so on.
export function copyNumbers(keys: string[]): number[] {
  const seen = new Map<string, number>();
  return keys.map((key) => {
    const copy = (seen.get(key) ?? 0) + 1;
    seen.set(key, copy);
    return copy;
  });
}

// Which entries (by index) are new. Copy n of a key is new only when the
// ledger holds fewer than n rows with that key. Callers that send only part
// of a file pass each row's copy number from the whole file, so the second
// fare in a file still counts as copy 2 when the first was already stored.
// An entry without a valid copy number is numbered by its place in this list.
// A copy number already used earlier in this list is not stored twice.
export function freshByCopy(
  entries: { key: string; copy?: number | undefined }[],
  storedCount: (key: string) => number,
): number[] {
  const fallback = copyNumbers(entries.map((entry) => entry.key));
  const stored = new Map<string, number>();
  const used = new Map<string, Set<number>>();
  const fresh: number[] = [];
  entries.forEach((entry, index) => {
    const given = entry.copy;
    const copy =
      typeof given === "number" && Number.isInteger(given) && given >= 1
        ? given
        : (fallback[index] ?? 1);
    let taken = used.get(entry.key);
    if (!taken) {
      taken = new Set();
      used.set(entry.key, taken);
    }
    if (taken.has(copy)) return;
    taken.add(copy);
    let have = stored.get(entry.key);
    if (have === undefined) {
      have = storedCount(entry.key);
      stored.set(entry.key, have);
    }
    if (copy > have) fresh.push(index);
  });
  return fresh;
}

// Which rows of a whole file are new (see freshByCopy). Two real $2.75 fares
// on one day both store; uploading that file again adds nothing; a shorter
// export with one copy adds nothing and deletes nothing.
export function freshByOccurrence(
  keys: string[],
  storedCount: (key: string) => number,
): number[] {
  return freshByCopy(keys.map((key) => ({ key })), storedCount);
}
