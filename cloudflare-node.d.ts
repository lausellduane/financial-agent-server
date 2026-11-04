declare module "cloudflare:node" {
  export function httpServerHandler(input: { port: number }): {
    fetch(
      request: Request,
      env?: unknown,
      ctx?: unknown,
    ): Promise<Response> | Response;
  };
}

interface SqlStorageCursor<T> {
  toArray(): T[];
}

interface SqlStorage {
  exec<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursor<T>;
}

interface DurableObjectState {
  storage: {
    sql: SqlStorage;
    transactionSync<T>(callback: () => T): T;
  };
  blockConcurrencyWhile(callback: () => Promise<void>): Promise<void>;
}

declare module "cloudflare:workers" {
  export const env: {
    AI: {
      run(
        model: string,
        input: {
          messages: { role: string; content: string }[];
          temperature?: number;
          max_tokens?: number;
        },
      ): Promise<unknown>;
    };
    LEDGER: {
      idFromName(name: string): unknown;
      get(id: unknown): {
        load(): Promise<Record<string, string>[]>;
        replace(rows: Record<string, string>[]): Promise<number>;
      };
    };
  };

  export abstract class DurableObject {
    ctx: DurableObjectState;
    constructor(ctx: DurableObjectState, env: unknown);
  }
}
