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
  uniqueMerchants,
  usesSignedCents,
} from "./statement.js";

export { parseCsv } from "./statement.js";

// Same shape Ledger stores. This file does not import ledger.ts, so Node
// (`npm start` and the csv test) never loads cloudflare:workers.
type LedgerRecord = {
  payload: Record<string, string>;
  category: string;
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
  cors({
    origin: allowedOrigins(),
    allowedHeaders: ["Content-Type", "Cf-Access-Jwt-Assertion"],
  })(req, res, next);
});
app.use(express.json());
app.use("/api", accessMiddleware);

const upload = multer({
  ...(onWorkers()
    ? { storage: multer.memoryStorage() }
    : { dest: path.join(__dirname, "uploads") }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// Node keeps one statement in this process. The Worker stores each Access
// identity in its own Ledger Durable Object, including the last query intent.
let memory: { rows: LedgerRecord[]; intent: string | null } = {
  rows: [],
  intent: null,
};

async function ledgerStub(identity: AccessIdentity | undefined) {
  if (!identity) throw new Error("Missing Access identity");
  const { env } = await import("cloudflare:workers");
  return env.LEDGER.get(env.LEDGER.idFromName(ledgerId(identity)));
}

async function readLedger(
  identity: AccessIdentity | undefined,
): Promise<LedgerRecord[]> {
  if (!onWorkers()) return memory.rows;
  const stub = await ledgerStub(identity);
  return stub.load();
}

async function writeLedger(
  rows: LedgerRecord[],
  identity: AccessIdentity | undefined,
): Promise<void> {
  if (!onWorkers()) {
    memory = { rows, intent: null };
    return;
  }
  const stub = await ledgerStub(identity);
  await stub.replace(rows);
}

async function readIntent(
  identity: AccessIdentity | undefined,
): Promise<QueryIntent | null> {
  const raw = onWorkers()
    ? await (await ledgerStub(identity)).loadIntent()
    : memory.intent;
  if (!raw) return null;
  try {
    return validateIntent(JSON.parse(raw), "stored");
  } catch {
    return null;
  }
}

async function writeIntent(
  intent: QueryIntent,
  identity: AccessIdentity | undefined,
): Promise<void> {
  const raw = JSON.stringify(intent);
  if (!onWorkers()) {
    memory.intent = raw;
    return;
  }
  const stub = await ledgerStub(identity);
  await stub.saveIntent(raw);
}

async function categorizeRows(
  rows: Record<string, string>[],
): Promise<LedgerRecord[]> {
  const fields = rows.length ? pickDisplayFields(rows) : null;
  const signed = fields ? usesSignedCents(rows, fields.amount) : false;
  const draft = rows.map((row) => {
    const narrative = fields ? rowNarrative(row, fields.description) : "";
    const cents = parseAmountCents(fields?.amount ? row[fields.amount] : undefined);
    return {
      row,
      narrative,
      category: categorizeNarrative(narrative, cents, signed),
    };
  });
  const unknown = [
    ...new Set(
      draft
        .filter((item) => item.category === "unknown" && item.narrative.trim())
        .map((item) => item.narrative),
    ),
  ];
  const assigned = new Map<string, Category>();
  for (let offset = 0; offset < unknown.length; offset += CATEGORY_BATCH) {
    const batch = unknown.slice(offset, offset + CATEGORY_BATCH);
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
  return draft.map((item) => ({
    payload: item.row,
    category:
      item.category === "unknown"
        ? (assigned.get(item.narrative) ?? "other")
        : item.category,
  }));
}

function toViews(records: LedgerRecord[]): TxView[] {
  if (!records.length) return [];
  const fields = pickDisplayFields(records.map((record) => record.payload));
  const views: TxView[] = [];
  for (const record of records) {
    const narrative = rowNarrative(record.payload, fields.description);
    const merchant = cleanMerchantName(narrative);
    const amountCents = parseAmountCents(
      fields.amount ? record.payload[fields.amount] : undefined,
    );
    if (!amountCents || merchant === "Unknown merchant") continue;
    views.push({
      date: normalizeDate(fields.date ? String(record.payload[fields.date] ?? "") : ""),
      merchant,
      narrative,
      amountCents,
      category: isCategory(record.category) ? record.category : "other",
    });
  }
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
      const records = await categorizeRows(rows);
      await writeLedger(records, res.locals.access);
      const fields = rows[0] ? Object.keys(rows[0]) : [];
      const displayFields = rows.length ? pickDisplayFields(rows) : null;
      const columns = fields.map((field) => columnStats(rows, field));
      const categoryCounts: Record<string, number> = {};
      for (const record of records) {
        categoryCounts[record.category] = (categoryCounts[record.category] ?? 0) + 1;
      }
      console.log("Upload categorized:", {
        count: records.length,
        categoryCounts,
      });
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

app.post("/api/query", async (req: Request, res: Response): Promise<void> => {
  const question = String(req.body?.question ?? "");
  const records = await readLedger(res.locals.access);
  if (!records.length) {
    res.status(400).json({ error: "Please upload a transaction report first." });
    return;
  }

  try {
    const views = toViews(records);
    const known = views.flatMap((view) => [view.narrative, view.merchant]);
    const previous = await readIntent(res.locals.access);
    const intent = await resolveIntent(question, previous, known);
    if (!intent) {
      res.json({
        answer: "I couldn't tell which category or merchant you meant.",
      });
      return;
    }
    await writeIntent(intent, res.locals.access);
    const matched = selectTransactions(views, intent);
    res.json({ answer: formatAnswer(matched, intent.op) });
  } catch (error) {
    console.error("Agent Execution Bug: ", error);
    res.status(500).json({ error: "Failed to process financial array accurately." });
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

export { app };

const entry = process.argv[1];
const isNodeEntry = !!entry && !!__filename && path.resolve(entry) === __filename;

if (isNodeEntry) {
  const port = Number(process.env.PORT ?? PORT);
  app.listen(port, () =>
    console.log(`Backend active on http://localhost:${port}`),
  );
}
