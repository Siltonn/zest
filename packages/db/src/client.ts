import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export type Database = ReturnType<typeof createDatabase>;

/**
 * The pool holds the event loop open, so anything short-lived — a test, a
 * script — needs a way to let the process exit. `closeDatabase` is that way.
 */
const pools = new WeakMap<object, ReturnType<typeof postgres>>();

export function createDatabase(connectionString: string, options?: { max?: number }) {
  const sql = postgres(connectionString, { max: options?.max ?? 10 });
  const db = drizzle(sql, { schema, casing: "snake_case" });
  pools.set(db, sql);
  return db;
}

export async function closeDatabase(db: Database): Promise<void> {
  const sql = pools.get(db);
  if (sql) await sql.end({ timeout: 5 });
}

let cached: Database | undefined;

/** Convenience accessor for scripts; apps inject their own instance via DI. */
export function getDatabase(): Database {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    cached = createDatabase(url);
  }
  return cached;
}
