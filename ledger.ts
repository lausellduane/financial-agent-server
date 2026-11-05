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
    });
  }

  async replace(rows: TxRow[]): Promise<number> {
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
    });
    return rows.length;
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
