import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(connectionString: string, options?: { max?: number }) {
  const sql = postgres(connectionString, { max: options?.max ?? 10 });
  return drizzle(sql, { schema, casing: "snake_case" });
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
