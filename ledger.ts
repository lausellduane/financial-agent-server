import { DurableObject } from "cloudflare:workers";

export type TxRow = Record<string, string>;

// One object named "statement" holds the single uploaded report. The UI has
// no session id; a later user id can replace that name.
export class Ledger extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
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
      for (const row of rows) {
        this.ctx.storage.sql.exec(
          "INSERT INTO transactions (payload) VALUES (?)",
          JSON.stringify(row),
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
