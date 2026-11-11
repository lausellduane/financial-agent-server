import { DurableObject } from "cloudflare:workers";
import { CATEGORIES } from "./categories.js";
import { dedupeKeys } from "./statement.js";

export type TxRow = Record<string, string>;

export type LedgerRecord = {
  id: number;
  payload: TxRow;
  category: string | null;
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
  // Same merchant, date, and amount. See dedupeKey in statement.ts.
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

// Rows saved before categories existed have a NULL category. "unknown" means
// a later attempt still owes the model a category. Neither is "other".
// 002 adds the dedupe key so a second upload appends instead of replacing.
export const LEDGER_MIGRATIONS = [
  "001_category_and_query_intent",
  "002_append_dedupe_key",
];
export const LEDGER_MIGRATION: string = LEDGER_MIGRATIONS[LEDGER_MIGRATIONS.length - 1] ?? "";

const INSERT_BATCH = 40;
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
  sql.exec(
    "CREATE INDEX IF NOT EXISTS transactions_dedupe_key ON transactions (dedupe_key)",
  );
  backfillDedupeKeys(sql);
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
  for (const name of LEDGER_MIGRATIONS) {
    sql.exec("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)", name);
  }
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
// still bumps on every upload, which stops a slow query from writing the
// previous question or categories back onto a ledger that changed under it.
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

  private hasKey(key: string): boolean {
    return (
      this.ctx.storage.sql
        .exec("SELECT 1 FROM transactions WHERE dedupe_key = ? LIMIT 1", key)
        .toArray().length > 0
    );
  }

  // Keys from this list that are not stored yet, in order, without repeats.
  async unseenKeys(keys: string[]): Promise<string[]> {
    return this.ctx.storage.transactionSync(() => {
      const seen = new Set<string>();
      const fresh: string[] = [];
      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (!this.hasKey(key)) fresh.push(key);
      }
      return fresh;
    });
  }

  // Adds rows whose key is not stored yet. Rejects the whole upload, without
  // bumping the version, if the ledger would pass maxRows.
  async append(
    rows: StoredRow[],
    range: DateRange = { startDate: null, endDate: null },
    rulesVersion: string | null = null,
    maxRows: number = Number.POSITIVE_INFINITY,
  ): Promise<AppendResult> {
    const uploadedAt = new Date().toISOString();
    return this.ctx.storage.transactionSync((): AppendResult => {
      const before = this.count();
      const seen = new Set<string>();
      const fresh: StoredRow[] = [];
      for (const row of rows) {
        if (seen.has(row.key)) continue;
        seen.add(row.key);
        if (!this.hasKey(row.key)) fresh.push(row);
      }
      const total = before + fresh.length;
      if (total > maxRows) return { ok: false, total };

      const version = this.version() + 1;
      for (let offset = 0; offset < fresh.length; offset += INSERT_BATCH) {
        const chunk = fresh.slice(offset, offset + INSERT_BATCH);
        const placeholders = chunk.map(() => "(?, ?, ?)").join(", ");
        const bindings = chunk.flatMap((row) => [
          JSON.stringify(row.payload),
          storedCategory(row.category),
          row.key,
        ]);
        this.ctx.storage.sql.exec(
          `INSERT INTO transactions (payload, category, dedupe_key) VALUES ${placeholders}`,
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
        .exec<{ id: number; payload: string; category: string | null }>(
          "SELECT id, payload, category FROM transactions ORDER BY id",
        )
        .toArray();
      return {
        version,
        rulesVersion: this.readMeta("category_rules_version"),
        records: stored.map((row) => ({
          id: row.id,
          payload: JSON.parse(row.payload) as TxRow,
          category: row.category ? row.category : null,
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
