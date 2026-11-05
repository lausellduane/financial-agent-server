import { DurableObject } from "cloudflare:workers";
import { isCategory } from "./categories.js";

export type TxRow = Record<string, string>;

export type LedgerRecord = {
  payload: TxRow;
  category: string;
};

// Rows created before categories existed. Fresh databases get the column from
// CREATE TABLE; already-deployed objects take the ALTER branch.
export const LEDGER_MIGRATION = "001_category_and_query_intent";

const INSERT_BATCH = 40;

type SqlExec = DurableObject["ctx"]["storage"]["sql"];

export function applyLedgerMigrations(sql: SqlExec): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other'
    )
  `);
  const columns = sql
    .exec<{ name: string }>("PRAGMA table_info(transactions)")
    .toArray();
  if (!columns.some((column) => column.name === "category")) {
    sql.exec(
      "ALTER TABLE transactions ADD COLUMN category TEXT NOT NULL DEFAULT 'other'",
    );
  }
  sql.exec(`
    CREATE TABLE IF NOT EXISTS query_intent (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      intent TEXT NOT NULL
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

function storedCategory(value: string): string {
  return isCategory(value) ? value : "other";
}

// One object per Access identity (email, otherwise sub). Callers pass that
// string to idFromName. The category is written at upload. The last parsed
// query intent is the follow-up context for that same identity.
export class Ledger extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      applyLedgerMigrations(ctx.storage.sql);
    });
  }

  // Re-run after a test (or a future repair) drops the new columns.
  async migrate(): Promise<{ columns: string[]; migration: string }> {
    applyLedgerMigrations(this.ctx.storage.sql);
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(transactions)")
      .toArray()
      .map((column) => column.name);
    return { columns, migration: LEDGER_MIGRATION };
  }

  async replace(rows: LedgerRecord[]): Promise<number> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM transactions");
      this.ctx.storage.sql.exec("DELETE FROM query_intent");
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
    });
    return rows.length;
  }

  async load(): Promise<LedgerRecord[]> {
    const stored = this.ctx.storage.sql
      .exec<{ payload: string; category: string | null }>(
        "SELECT payload, category FROM transactions ORDER BY id",
      )
      .toArray();
    return stored.map((row) => ({
      payload: JSON.parse(row.payload) as TxRow,
      category: storedCategory(row.category ?? "other"),
    }));
  }

  async saveIntent(intent: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM query_intent");
      this.ctx.storage.sql.exec(
        "INSERT INTO query_intent (id, intent) VALUES (1, ?)",
        intent,
      );
    });
  }

  async loadIntent(): Promise<string | null> {
    const row = this.ctx.storage.sql
      .exec<{ intent: string }>("SELECT intent FROM query_intent WHERE id = 1")
      .toArray()[0];
    return row?.intent ?? null;
  }
}
