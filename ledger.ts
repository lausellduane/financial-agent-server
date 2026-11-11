import { DurableObject } from "cloudflare:workers";
import { CATEGORIES } from "./categories.js";

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
};

// Rows saved before categories existed have a NULL category. "unknown" means
// a later attempt still owes the model a category. Neither is "other".
export const LEDGER_MIGRATION = "001_category_and_query_intent";

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
  sql.exec(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)",
    LEDGER_MIGRATION,
  );
}

// One object per Access identity. The statement version is what stops a slow
// query from writing the previous question back onto a replacement upload.
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

  async replace(
    rows: StoredRow[],
    range: DateRange = { startDate: null, endDate: null },
    rulesVersion: string | null = null,
  ): Promise<{ count: number; version: number }> {
    const uploadedAt = new Date().toISOString();
    let version = 0;
    this.ctx.storage.transactionSync(() => {
      version = this.version() + 1;
      this.ctx.storage.sql.exec("DELETE FROM transactions");
      for (let offset = 0; offset < rows.length; offset += INSERT_BATCH) {
        const chunk = rows.slice(offset, offset + INSERT_BATCH);
        const placeholders = chunk.map(() => "(?, ?)").join(", ");
        const bindings = chunk.flatMap((row) => [
          JSON.stringify(row.payload),
          storedCategory(row.category),
        ]);
        this.ctx.storage.sql.exec(
          `INSERT INTO transactions (payload, category) VALUES ${placeholders}`,
          ...bindings,
        );
      }
      this.putMeta("statement_version", String(version));
      this.putMeta("intent", "");
      this.putMeta("intent_version", "");
      this.putMeta("uploaded_at", uploadedAt);
      this.putMeta("start_date", range.startDate ?? "");
      this.putMeta("end_date", range.endDate ?? "");
      if (rulesVersion) this.putMeta("category_rules_version", rulesVersion);
      else {
        this.ctx.storage.sql.exec(
          "DELETE FROM ledger_meta WHERE key = 'category_rules_version'",
        );
      }
    });
    return { count: rows.length, version };
  }

  async summary(): Promise<ReportSummary> {
    return this.ctx.storage.transactionSync(() => {
      const count = Number(
        this.ctx.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM transactions")
          .toArray()[0]?.n ?? 0,
      );
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
