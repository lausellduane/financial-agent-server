import { DurableObject } from "cloudflare:workers";

export type TxRow = Record<string, string>;

// One object per Access identity (email, otherwise sub). Callers pass that
// string to idFromName. Rows are inserted in batches so a full statement is
// one transaction instead of one SQL call per row.
const INSERT_BATCH = 50;

export class Ledger extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          payload TEXT NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS ledger_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
    });
  }

  async replace(
    rows: TxRow[],
    range: { startDate: string | null; endDate: string | null } = {
      startDate: null,
      endDate: null,
    },
  ): Promise<number> {
    const uploadedAt = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM transactions");
      for (let offset = 0; offset < rows.length; offset += INSERT_BATCH) {
        const chunk = rows.slice(offset, offset + INSERT_BATCH);
        const placeholders = chunk.map(() => "(?)").join(", ");
        this.ctx.storage.sql.exec(
          `INSERT INTO transactions (payload) VALUES ${placeholders}`,
          ...chunk.map((row) => JSON.stringify(row)),
        );
      }
      this.putMeta("uploaded_at", uploadedAt);
      this.putMeta("start_date", range.startDate ?? "");
      this.putMeta("end_date", range.endDate ?? "");
    });
    return rows.length;
  }

  // One read: row count plus the dates and upload time saved with those rows.
  async summary(): Promise<{
    loaded: boolean;
    count: number;
    startDate: string | null;
    endDate: string | null;
    uploadedAt: string | null;
  }> {
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
      const meta = new Map(
        this.ctx.storage.sql
          .exec<{ key: string; value: string }>(
            "SELECT key, value FROM ledger_meta",
          )
          .toArray()
          .map((row) => [row.key, row.value]),
      );
      const text = (key: string) => {
        const value = meta.get(key);
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

  private putMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO ledger_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  async load(): Promise<TxRow[]> {
    const stored = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM transactions ORDER BY id",
      )
      .toArray();
    return stored.map((row) => JSON.parse(row.payload) as TxRow);
  }
}
