import { DurableObject } from "cloudflare:workers";
import { CATEGORIES } from "./categories.js";
import {
  dedupeKeys,
  freshByOccurrence,
  headerShape,
  parseLayout,
  uploadLayout,
  type UploadLayout,
} from "./statement.js";

export type TxRow = Record<string, string>;

export type LedgerRecord = {
  id: number;
  payload: TxRow;
  category: string | null;
  // How this row's upload was read. Null only if it could not be parsed.
  layout: UploadLayout | null;
};

export type DateRange = {
  startDate: string | null;
  endDate: string | null;
};

export type ReportSummary = {
  loaded: boolean;
  count: number;
  startDate: string | null;
  endDate: string | null;
  uploadedAt: string | null;
};

export type StoredRow = {
  payload: TxRow;
  category: string;
  // Date, header-picked text, and amount. See dedupeKey in statement.ts.
  key: string;
};

export type AppendResult =
  | {
      ok: true;
      added: number;
      duplicates: number;
      total: number;
      version: number;
    }
  | { ok: false; total: number };

export type ClearResult = { removed: number; version: number };

// Rows saved before categories existed have a NULL category. "unknown" means
// a later attempt still owes the model a category. Neither is "other".
// 002 adds the dedupe key so a second upload appends instead of replacing.
// 003 saves each upload's columns and sign, and rewrites keys with the
// header-only text column.
export const LEDGER_MIGRATIONS = [
  "001_category_and_query_intent",
  "002_append_dedupe_key",
  "003_upload_layout_header_key",
];
export const LEDGER_MIGRATION: string = LEDGER_MIGRATIONS[LEDGER_MIGRATIONS.length - 1] ?? "";

// Durable Object SQL allows at most 100 bound parameters per statement, and
// each row binds 4.
const INSERT_BATCH = 25;
const ALLOWED = new Set<string>([...CATEGORIES, "unknown"]);

function storedCategory(value: string): string {
  return ALLOWED.has(value) ? value : "unknown";
}

type Sql = DurableObjectState["storage"]["sql"];

export function applyLedgerMigrations(sql: Sql): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL
    )
  `);
  const columns = sql
    .exec<{ name: string }>("PRAGMA table_info(transactions)")
    .toArray();
    if (!columns.some((column) => column.name === "category")) {
    // Nullable on purpose. A NOT NULL DEFAULT 'other' made old Chipotle rows
    // look categorized. Rows already stored as other are left alone: that
    // value can be a real classification, and this repo has no deploy of the
    // earlier defaulted schema (see the spike doc).
    sql.exec("ALTER TABLE transactions ADD COLUMN category TEXT");
  }
  if (!columns.some((column) => column.name === "dedupe_key")) {
    sql.exec("ALTER TABLE transactions ADD COLUMN dedupe_key TEXT");
  }
  if (!columns.some((column) => column.name === "upload_id")) {
    sql.exec("ALTER TABLE transactions ADD COLUMN upload_id INTEGER");
  }
  sql.exec(
    "CREATE INDEX IF NOT EXISTS transactions_dedupe_key ON transactions (dedupe_key)",
  );
  sql.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      layout TEXT NOT NULL,
      uploaded_at TEXT
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS ledger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )
  `);
  const applied = new Set(
    sql
      .exec<{ name: string }>("SELECT name FROM schema_migrations")
      .toArray()
      .map((row) => row.name),
  );
  if (!applied.has("003_upload_layout_header_key")) rewriteDedupeKeys(sql);
  backfillDedupeKeys(sql);
  assignLegacyUploads(sql);
  for (const name of LEDGER_MIGRATIONS) {
    sql.exec("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)", name);
  }
}

// Keys from 002 picked the text column by scoring row contents. The new key
// depends only on each row's own headers and values, so recomputing it is
// deterministic. Nothing is deleted.
function rewriteDedupeKeys(sql: Sql): void {
  const stored = sql
    .exec<{ id: number; payload: string }>("SELECT id, payload FROM transactions ORDER BY id")
    .toArray();
  const keys = dedupeKeys(stored.map((row) => JSON.parse(row.payload) as TxRow));
  stored.forEach((row, index) => {
    sql.exec("UPDATE transactions SET dedupe_key = ? WHERE id = ?", keys[index] ?? null, row.id);
  });
}

// Rows saved before uploads were recorded came from one replace-only upload.
// Each header layout among them becomes one upload, so its columns and sign
// are fixed now and later uploads cannot change how they read.
function assignLegacyUploads(sql: Sql): void {
  const legacy = sql
    .exec<{ id: number; payload: string }>(
      "SELECT id, payload FROM transactions WHERE upload_id IS NULL ORDER BY id",
    )
    .toArray();
  if (!legacy.length) return;
  const groups = new Map<string, { ids: number[]; rows: TxRow[] }>();
  for (const row of legacy) {
    const payload = JSON.parse(row.payload) as TxRow;
    const shape = headerShape(payload);
    const group = groups.get(shape) ?? { ids: [], rows: [] };
    group.ids.push(row.id);
    group.rows.push(payload);
    groups.set(shape, group);
  }
  for (const group of groups.values()) {
    const uploadId = insertUpload(sql, uploadLayout(group.rows), null);
    for (const id of group.ids) {
      sql.exec("UPDATE transactions SET upload_id = ? WHERE id = ?", uploadId, id);
    }
  }
}

function insertUpload(sql: Sql, layout: UploadLayout, uploadedAt: string | null): number {
  const row = sql
    .exec<{ id: number }>(
      "INSERT INTO uploads (layout, uploaded_at) VALUES (?, ?) RETURNING id",
      JSON.stringify(layout),
      uploadedAt,
    )
    .toArray()[0];
  if (!row) throw new Error("upload insert failed");
  return Number(row.id);
}

// Rows stored by the replace-only upload have no key. Fill it in so the next
// upload of the same statement is recognized. Nothing is deleted here, even if
// an old upload stored the same charge twice.
function backfillDedupeKeys(sql: Sql): void {
  const missing = Number(
    sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE dedupe_key IS NULL")
      .toArray()[0]?.n ?? 0,
  );
  if (!missing) return;
  const stored = sql
    .exec<{ id: number; payload: string; dedupe_key: string | null }>(
      "SELECT id, payload, dedupe_key FROM transactions ORDER BY id",
    )
    .toArray();
  const keys = dedupeKeys(stored.map((row) => JSON.parse(row.payload) as TxRow));
  stored.forEach((row, index) => {
    if (row.dedupe_key !== null) return;
    sql.exec(
      "UPDATE transactions SET dedupe_key = ? WHERE id = ?",
      keys[index] ?? null,
      row.id,
    );
  });
}

function earlier(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

// One object per Access identity. Uploads append to it. The statement version
// bumps on every upload that adds rows, and on a clear, which stops a slow
// query from writing the previous question or categories back onto a ledger
// that changed under it. An upload that adds nothing leaves it alone.
export class Ledger extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      applyLedgerMigrations(ctx.storage.sql);
    });
  }

  async migrate(): Promise<{ columns: string[]; migration: string }> {
    applyLedgerMigrations(this.ctx.storage.sql);
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(transactions)")
      .toArray()
      .map((column) => column.name);
    return { columns, migration: LEDGER_MIGRATION };
  }

  private readMeta(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM ledger_meta WHERE key = ?",
        key,
      )
      .toArray()[0];
    return row?.value ?? null;
  }

  private putMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO ledger_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  async currentVersion(): Promise<number> {
    return this.ctx.storage.transactionSync(() => this.version());
  }

  private version(): number {
    const raw = this.readMeta("statement_version");
    const parsed = raw === null ? 0 : Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  private count(): number {
    return Number(
      this.ctx.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM transactions")
        .toArray()[0]?.n ?? 0,
    );
  }

  private keyCount(key: string): number {
    return Number(
      this.ctx.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE dedupe_key = ?", key)
        .toArray()[0]?.n ?? 0,
    );
  }

  // Which of these file rows (by index) would be new, plus the stored count,
  // so the upload can check the row limit before it categorizes anything.
  async plan(keys: string[]): Promise<{ fresh: number[]; stored: number }> {
    return this.ctx.storage.transactionSync(() => ({
      fresh: freshByOccurrence(keys, (key) => this.keyCount(key)),
      stored: this.count(),
    }));
  }

  // Adds the file rows the ledger does not hold yet, counting repeats of one
  // key (see freshByOccurrence). Rejects the whole upload, writing nothing,
  // if the ledger would pass maxRows. An upload with no new rows writes
  // nothing either, so a question in flight keeps its version and intent.
  async append(
    rows: StoredRow[],
    range: DateRange = { startDate: null, endDate: null },
    rulesVersion: string | null = null,
    maxRows: number = Number.POSITIVE_INFINITY,
    layout: UploadLayout | null = null,
  ): Promise<AppendResult> {
    const uploadedAt = new Date().toISOString();
    return this.ctx.storage.transactionSync((): AppendResult => {
      const before = this.count();
      const fresh = freshByOccurrence(
        rows.map((row) => row.key),
        (key) => this.keyCount(key),
      ).map((index) => rows[index] as StoredRow);
      const total = before + fresh.length;
      if (total > maxRows) return { ok: false, total };
      if (!fresh.length) {
        return { ok: true, added: 0, duplicates: rows.length, total, version: this.version() };
      }

      const version = this.version() + 1;
      const uploadId = insertUpload(
        this.ctx.storage.sql,
        layout ?? uploadLayout(rows.map((row) => row.payload)),
        uploadedAt,
      );
      for (let offset = 0; offset < fresh.length; offset += INSERT_BATCH) {
        const chunk = fresh.slice(offset, offset + INSERT_BATCH);
        const placeholders = chunk.map(() => "(?, ?, ?, ?)").join(", ");
        const bindings = chunk.flatMap((row) => [
          JSON.stringify(row.payload),
          storedCategory(row.category),
          row.key,
          uploadId,
        ]);
        this.ctx.storage.sql.exec(
          `INSERT INTO transactions (payload, category, dedupe_key, upload_id) VALUES ${placeholders}`,
          ...bindings,
        );
      }
      const text = (key: string) => this.readMeta(key) || null;
      const hadRows = before > 0;
      const startDate = hadRows ? earlier(text("start_date"), range.startDate) : range.startDate;
      const endDate = hadRows ? later(text("end_date"), range.endDate) : range.endDate;
      this.putMeta("statement_version", String(version));
      this.putMeta("intent", "");
      this.putMeta("intent_version", "");
      this.putMeta("uploaded_at", uploadedAt);
      this.putMeta("start_date", startDate ?? "");
      this.putMeta("end_date", endDate ?? "");
      // Older rows keep their stamp. If it is stale, the next query re-rules
      // the whole ledger, new rows included.
      if (!hadRows) {
        if (rulesVersion) this.putMeta("category_rules_version", rulesVersion);
        else {
          this.ctx.storage.sql.exec(
            "DELETE FROM ledger_meta WHERE key = 'category_rules_version'",
          );
        }
      }
      return {
        ok: true,
        added: fresh.length,
        duplicates: rows.length - fresh.length,
        total,
        version,
      };
    });
  }

  // Deletes every stored row and upload for this identity. The version bumps
  // so a question or categorization in flight gets 409 instead of writing
  // onto the empty ledger, and the saved question is dropped.
  async clear(): Promise<ClearResult> {
    return this.ctx.storage.transactionSync((): ClearResult => {
      const removed = this.count();
      const version = this.version() + 1;
      this.ctx.storage.sql.exec("DELETE FROM transactions");
      this.ctx.storage.sql.exec("DELETE FROM uploads");
      this.ctx.storage.sql.exec(
        "DELETE FROM ledger_meta WHERE key IN ('intent', 'intent_version', 'uploaded_at', 'start_date', 'end_date', 'category_rules_version')",
      );
      this.putMeta("statement_version", String(version));
      return { removed, version };
    });
  }

  async summary(): Promise<ReportSummary> {
    return this.ctx.storage.transactionSync(() => {
      const count = this.count();
      if (!count) {
        return {
          loaded: false,
          count: 0,
          startDate: null,
          endDate: null,
          uploadedAt: null,
        };
      }
      const text = (key: string) => {
        const value = this.readMeta(key);
        return value ? value : null;
      };
      return {
        loaded: true,
        count,
        startDate: text("start_date"),
        endDate: text("end_date"),
        uploadedAt: text("uploaded_at"),
      };
    });
  }

  async load(): Promise<{
    records: LedgerRecord[];
    version: number;
    rulesVersion: string | null;
  }> {
    return this.ctx.storage.transactionSync(() => {
      const version = this.version();
      const stored = this.ctx.storage.sql
        .exec<{ id: number; payload: string; category: string | null; layout: string | null }>(
          `SELECT t.id, t.payload, t.category, u.layout
             FROM transactions t LEFT JOIN uploads u ON u.id = t.upload_id
            ORDER BY t.id`,
        )
        .toArray();
      return {
        version,
        rulesVersion: this.readMeta("category_rules_version"),
        records: stored.map((row) => ({
          id: row.id,
          payload: JSON.parse(row.payload) as TxRow,
          category: row.category ? row.category : null,
          layout: parseLayout(row.layout),
        })),
      };
    });
  }

  // Writes categories only when this is still the statement the caller read.
  async updateCategories(
    updates: { id: number; category: string }[],
    version: number,
    rulesVersion: string | null = null,
  ): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      if (this.version() !== version) return false;
      for (const update of updates) {
        this.ctx.storage.sql.exec(
          "UPDATE transactions SET category = ? WHERE id = ?",
          storedCategory(update.category),
          update.id,
        );
      }
      if (rulesVersion) this.putMeta("category_rules_version", rulesVersion);
      return true;
    });
  }

  async saveIntent(intent: string, version: number): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      if (this.version() !== version) return false;
      this.putMeta("intent", intent);
      this.putMeta("intent_version", String(version));
      return true;
    });
  }

  async loadRulesVersion(): Promise<string | null> {
    return this.ctx.storage.transactionSync(() => this.readMeta("category_rules_version"));
  }

  async saveRulesVersion(rulesVersion: string, statementVersion: number): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      if (this.version() !== statementVersion) return false;
      this.putMeta("category_rules_version", rulesVersion);
      return true;
    });
  }

  async loadIntent(): Promise<{ intent: string | null; version: number }> {
    return this.ctx.storage.transactionSync(() => {
      const version = this.version();
      const intent = this.readMeta("intent");
      const intentVersion = this.readMeta("intent_version");
      if (!intent || intentVersion !== String(version)) {
        return { intent: null, version };
      }
      return { intent, version };
    });
  }
}
