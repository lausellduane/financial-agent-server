import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import process from "node:process";
import { fileURLToPath } from "url";
import {
  accessMiddleware,
  ledgerId,
  onWorkers,
  type AccessIdentity,
} from "./access.js";
import {
  CATEGORY_BATCH,
  buildCategoryMessages,
  categorizeNarrative,
  isCategory,
  parseCategoryAssignments,
  type Category,
} from "./categories.js";
import { MAX_LEDGER_ROWS, MAX_UPLOAD_BYTES, PORT } from "./constants.js";
import { completeChat, llmProvider, ollamaModel, workersAiModel } from "./llm.js";
import {
  buildIntentMessages,
  formatAnswer,
  intentFromModel,
  interpretQuestion,
  selectTransactions,
  validateIntent,
  type QueryIntent,
  type TxView,
} from "./query-intent.js";
import {
  cleanMerchantName,
  columnStats,
  normalizeDate,
  parseAmountCents,
  parseCsv,
  pickDisplayFields,
  rowNarrative,
  statementDateRange,
  uniqueMerchants,
  usesSignedCents,
} from "./statement.js";

export { parseCsv } from "./statement.js";

export type ReportSummary = {
  loaded: boolean;
  count: number;
  startDate: string | null;
  endDate: string | null;
  uploadedAt: string | null;
};

type DateRange = { startDate: string | null; endDate: string | null };

type LedgerRecord = {
  id: number;
  payload: Record<string, string>;
  category: string | null;
};

type MemoryLedger = {
  rows: LedgerRecord[];
  intent: string | null;
  version: number;
  uploadedAt: string | null;
  startDate: string | null;
  endDate: string | null;
  nextId: number;
};

// Node dev keeps one statement for the whole process. It is not split by
// identity. Workers keep one Durable Object per Access identity.
let memory: MemoryLedger = {
  rows: [],
  intent: null,
  version: 0,
  uploadedAt: null,
  startDate: null,
  endDate: null,
  nextId: 1,
};

const moduleUrl = import.meta.url;
const __filename =
  typeof moduleUrl === "string" && moduleUrl.length > 0
    ? fileURLToPath(moduleUrl)
    : "";
const __dirname = __filename ? path.dirname(__filename) : "/tmp";

const app: Express = express();

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

const upload = multer({
  ...(onWorkers()
    ? { storage: multer.memoryStorage() }
    : { dest: path.join(__dirname, "uploads") }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

async function ledgerStub(identity: AccessIdentity) {
  const { env } = await import("cloudflare:workers");
  return env.LEDGER.get(env.LEDGER.idFromName(ledgerId(identity)));
}

function needsCategory(category: string | null): boolean {
  return category === null || category === "unknown";
}

async function classifyUnknown(narratives: string[]): Promise<Map<string, Category>> {
  const assigned = new Map<string, Category>();
  for (let offset = 0; offset < narratives.length; offset += CATEGORY_BATCH) {
    const batch = narratives.slice(offset, offset + CATEGORY_BATCH);
    try {
      const raw = await completeChat(buildCategoryMessages(batch));
      for (const [merchant, category] of parseCategoryAssignments(raw, batch)) {
        assigned.set(merchant, category);
      }
    } catch (error) {
      console.error(
        "Category model failed:",
        error instanceof Error ? error.message : "unknown",
      );
    }
  }
  return assigned;
}

async function resolveCategories(records: LedgerRecord[]): Promise<LedgerRecord[]> {
  if (!records.length) return [];
  const payloads = records.map((record) => record.payload);
  const fields = pickDisplayFields(payloads);
  const signed = usesSignedCents(payloads, fields.amount);
  const draft = records.map((record) => {
    const narrative = rowNarrative(record.payload, fields.description);
    const cents = parseAmountCents(
      fields.amount ? record.payload[fields.amount] : undefined,
    );
    return {
      record,
      narrative,
      ruled: categorizeNarrative(narrative, cents, signed),
    };
  });
  const pending = [
    ...new Set(
      draft
        .filter((item) => item.ruled === "unknown" && item.narrative.trim())
        .map((item) => item.narrative),
    ),
  ];
  const assigned = pending.length ? await classifyUnknown(pending) : new Map<string, Category>();
  return draft.map((item) => {
    if (item.ruled !== "unknown") {
      return { ...item.record, category: item.ruled };
    }
    const fromModel = assigned.get(item.narrative);
    return { ...item.record, category: fromModel ?? "unknown" };
  });
}

async function readLedger(
  identity: AccessIdentity | undefined,
): Promise<{ records: LedgerRecord[]; version: number }> {
  if (!onWorkers()) {
    return { records: memory.rows, version: memory.version };
  }
  if (!identity) throw new Error("Missing Access identity");
  return (await ledgerStub(identity)).load();
}

async function writeLedger(
  rows: { payload: Record<string, string>; category: string }[],
  identity: AccessIdentity | undefined,
  range: DateRange,
): Promise<number> {
  const uploadedAt = rows.length ? new Date().toISOString() : null;
  if (!onWorkers()) {
    memory.version += 1;
    memory.intent = null;
    memory.uploadedAt = uploadedAt;
    memory.startDate = rows.length ? range.startDate : null;
    memory.endDate = rows.length ? range.endDate : null;
    memory.rows = rows.map((row) => ({
      id: memory.nextId++,
      payload: row.payload,
      category: row.category,
    }));
    return memory.version;
  }
  if (!identity) throw new Error("Missing Access identity");
  const saved = await (
    await ledgerStub(identity)
  ).replace(rows, range);
  return saved.version;
}

async function updateCategories(
  updates: { id: number; category: string }[],
  version: number,
  identity: AccessIdentity | undefined,
): Promise<boolean> {
  if (!updates.length) return true;
  if (!onWorkers()) {
    if (memory.version !== version) return false;
    const byId = new Map(updates.map((update) => [update.id, update.category]));
    memory.rows = memory.rows.map((row) => {
      const category = byId.get(row.id);
      return category === undefined ? row : { ...row, category };
    });
    return true;
  }
  if (!identity) throw new Error("Missing Access identity");
  return (await ledgerStub(identity)).updateCategories(updates, version);
}

async function readIntent(
  identity: AccessIdentity | undefined,
  version: number,
): Promise<QueryIntent | null> {
  let raw: string | null;
  if (!onWorkers()) {
    raw = memory.version === version ? memory.intent : null;
  } else {
    if (!identity) throw new Error("Missing Access identity");
    const loaded = await (await ledgerStub(identity)).loadIntent();
    raw = loaded.version === version ? loaded.intent : null;
  }
  if (!raw) return null;
  try {
    return validateIntent(JSON.parse(raw), "stored");
  } catch {
    return null;
  }
}

async function writeIntent(
  intent: QueryIntent,
  version: number,
  identity: AccessIdentity | undefined,
): Promise<boolean> {
  const raw = JSON.stringify(intent);
  if (!onWorkers()) {
    if (memory.version !== version) return false;
    memory.intent = raw;
    return true;
  }
  if (!identity) throw new Error("Missing Access identity");
  return (await ledgerStub(identity)).saveIntent(raw, version);
}

async function hydrate(
  identity: AccessIdentity | undefined,
): Promise<{ records: LedgerRecord[]; version: number; unknown: number }> {
  const loaded = await readLedger(identity);
  const pending = loaded.records.filter((record) => needsCategory(record.category));
  if (!pending.length) {
    return {
      records: loaded.records,
      version: loaded.version,
      unknown: 0,
    };
  }
  const resolved = await resolveCategories(pending);
  const updates = resolved
    .filter((record) => record.category !== null)
    .map((record) => ({ id: record.id, category: record.category ?? "unknown" }));
  await updateCategories(updates, loaded.version, identity);
  const byId = new Map(resolved.map((record) => [record.id, record.category]));
  const records = loaded.records.map((record) => {
    const category = byId.get(record.id);
    return category === undefined ? record : { ...record, category };
  });
  return {
    records,
    version: loaded.version,
    unknown: records.filter((record) => needsCategory(record.category)).length,
  };
}

function toViews(records: LedgerRecord[]): TxView[] {
  if (!records.length) return [];
  const payloads = records.map((record) => record.payload);
  const fields = pickDisplayFields(payloads);
  const signed = usesSignedCents(payloads, fields.amount);
  const views: TxView[] = [];
  let skipped = 0;
  for (const record of records) {
    if (!isCategory(record.category ?? "")) continue;
    const narrative = rowNarrative(record.payload, fields.description);
    const merchant = cleanMerchantName(narrative);
    const amountCents = parseAmountCents(
      fields.amount ? record.payload[fields.amount] : undefined,
    );
    if (!amountCents || merchant === "Unknown merchant") {
      skipped += 1;
      continue;
    }
    views.push({
      date: normalizeDate(fields.date ? String(record.payload[fields.date] ?? "") : ""),
      merchant,
      narrative,
      amountCents,
      spendCents: signed ? -amountCents : Math.abs(amountCents),
      category: record.category as Category,
    });
  }
  if (skipped) console.log("Skipped unusable rows:", skipped);
  return views;
}

async function resolveIntent(
  question: string,
  previous: QueryIntent | null,
  known: string[],
): Promise<QueryIntent | null> {
  const interpreted = interpretQuestion(question, previous, known);
  if (interpreted?.confident) return interpreted.intent;

  let modelIntent: QueryIntent | null = null;
  try {
    const raw = await completeChat(buildIntentMessages(question, previous));
    modelIntent = intentFromModel(raw, question);
  } catch (error) {
    console.error(
      "Intent model failed:",
      error instanceof Error ? error.message : "unknown",
    );
  }
  if (
    modelIntent &&
    interpreted?.unrecognized &&
    modelIntent.scope === "all-spending"
  ) {
    modelIntent = null;
  }
  if (modelIntent) return modelIntent;
  if (
    interpreted &&
    (interpreted.intent.categories.length > 0 ||
      interpreted.intent.merchants.length > 0 ||
      interpreted.intent.excludeMerchants.length > 0)
  ) {
    return interpreted.intent;
  }
  return null;
}

async function reportFor(
  identity: AccessIdentity | undefined,
): Promise<ReportSummary> {
  if (!onWorkers()) {
    const count = memory.rows.length;
    return {
      loaded: count > 0,
      count,
      startDate: count > 0 ? memory.startDate : null,
      endDate: count > 0 ? memory.endDate : null,
      uploadedAt: count > 0 ? memory.uploadedAt : null,
    };
  }
  if (!identity) throw new Error("Missing Access identity");
  return (await ledgerStub(identity)).summary();
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
      const categorized = await resolveCategories(
        rows.map((payload) => ({ id: 0, payload, category: null })),
      );
      const range = rows.length ? statementDateRange(rows) : { startDate: null, endDate: null };
      await writeLedger(
        categorized.map((record) => ({
          payload: record.payload,
          category: record.category ?? "unknown",
        })),
        res.locals.access,
        range,
      );
      const fields = rows[0] ? Object.keys(rows[0]) : [];
      const displayFields = rows.length ? pickDisplayFields(rows) : null;
      const columns = fields.map((field) => columnStats(rows, field));
      const uncategorized = categorized.filter((record) =>
        needsCategory(record.category),
      ).length;
      const categoryCounts: Record<string, number> = {};
      for (const record of categorized) {
        const key = record.category ?? "unknown";
        categoryCounts[key] = (categoryCounts[key] ?? 0) + 1;
      }
      console.log("Upload categorized:", {
        count: categorized.length,
        categoryCounts,
        uncategorized,
      });
      res.json({
        message: "Data ingested successfully!",
        count: rows.length,
        uncategorized,
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

app.post("/api/query", async (req: Request, res: Response): Promise<void> => {
  try {
    const question = String(req.body?.question ?? "").trim();
    const hydrated = await hydrate(res.locals.access);
    if (!hydrated.records.length) {
      res.status(400).json({ error: "Please upload a transaction report first." });
      return;
    }
    if (!question) {
      res.json({
        answer: "I couldn't tell which category or merchant you meant.",
      });
      return;
    }
    const views = toViews(hydrated.records);
    const known = views.flatMap((view) => [view.narrative, view.merchant]);
    const previous = await readIntent(res.locals.access, hydrated.version);
    const intent = await resolveIntent(question, previous, known);
    if (!intent) {
      res.json({
        answer: hydrated.unknown
          ? "I couldn't tell which category or merchant you meant.\nSome charges are still uncategorized."
          : "I couldn't tell which category or merchant you meant.",
      });
      return;
    }
    await writeIntent(intent, hydrated.version, res.locals.access);
    const matched = selectTransactions(views, intent);
    let answer = formatAnswer(matched, intent);
    if (hydrated.unknown) {
      answer = `${answer}\nSome charges are still uncategorized.`;
    }
    res.json({ answer });
  } catch (error) {
    console.error("Agent Execution Bug: ", error);
    res.status(500).json({ error: "Failed to process financial array accurately." });
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
  console.error(
    "Request failed:",
    error instanceof Error ? error.message : "unknown error",
  );
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
