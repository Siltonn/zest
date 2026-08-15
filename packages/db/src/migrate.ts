import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate as runMigrations } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { createDatabase, closeDatabase, type Database } from "./client.ts";

/**
 * Applying schema changes at startup.
 *
 * The alternative — telling operators to run a migration command before every
 * upgrade — is the kind of instruction that works until someone is upgrading at
 * 2am, and then silently produces new code against an old schema. That failure
 * does not surface at boot; it surfaces later as a query against a table that
 * does not exist, on whichever code path happens to run first.
 *
 * drizzle-orm ships a runtime migrator, so this needs no drizzle-kit and no
 * toolchain in the image — just the .sql files and a connection.
 */

/**
 * A lock id, not a lock name: Postgres advisory locks are keyed by number.
 * Arbitrary, but must stay stable across versions or two releases could each
 * hold "the" migration lock and migrate at the same time.
 */
const MIGRATION_LOCK_ID = 4_275_309_001;

/**
 * Where the .sql files are, whether running from source or from a built image.
 *
 * Resolved relative to this module rather than the working directory, because
 * the server starts in apps/server and the seed script starts in packages/seed,
 * and neither should have to know how far away the migrations live.
 */
export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "migrations"), // dist/ or src/ inside the package
    join(here, "..", "..", "migrations"), // one level deeper
    resolve(process.cwd(), "migrations"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not find the migrations folder (looked from ${here}). ` +
      "The image build is expected to copy packages/db/migrations next to the compiled db package.",
  );
}

export type MigrateResult = {
  applied: boolean;
  /** False when another process held the lock and did the work instead. */
  ranHere: boolean;
};

/**
 * Runs any pending migrations, once, even if several processes start together.
 *
 * `MODE=api` and `MODE=worker` are the same image started twice; without a lock
 * both would migrate concurrently, and two transactions running the same
 * `CREATE TABLE` is at best one wasted error and at worst a half-applied
 * schema. `pg_advisory_lock` blocks the loser until the winner is finished, so
 * the second process finds nothing to do and carries on.
 */
export async function migrateToLatest(
  db: Database,
  options: { logger?: (message: string) => void } = {},
): Promise<MigrateResult> {
  const log = options.logger ?? (() => undefined);
  const folder = migrationsFolder();

  log(`waiting for the migration lock`);
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`);

  try {
    log(`applying migrations from ${folder}`);
    await runMigrations(db, { migrationsFolder: folder });
    return { applied: true, ranHere: true };
  } finally {
    // Released even if a migration threw, or the next boot would hang forever
    // waiting on a lock held by a process that already exited.
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`);
  }
}

/** Entry point for `node dist/migrate.js` — the manual path, for operators who
 *  would rather run migrations themselves than have the server do it. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const db = createDatabase(url, { max: 1 });
  try {
    await migrateToLatest(db, { logger: (m) => console.log(`[migrate] ${m}`) });
    console.log("[migrate] up to date");
  } finally {
    await closeDatabase(db);
  }
}

// Only when executed directly, so importing this module never migrates.
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main().catch((error) => {
    console.error(`[migrate] failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
