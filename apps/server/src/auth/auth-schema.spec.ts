import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getAuthTables } from "better-auth/db";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { authPlugins, authSchemaMap } from "./auth.options.ts";

/**
 * Does our hand-written schema still match what Better Auth asks for?
 *
 * Better Auth never creates tables. It declares the fields it expects and
 * leaves the DDL to its CLI, which can only apply migrations directly through
 * the built-in Kysely adapter — on Drizzle you own the schema no matter what.
 * `@zest/db/schema/auth.ts` is that schema, written by hand so the auth tables
 * read like every other table here.
 *
 * The cost of owning it is drift: bump `better-auth` and a new field, index or
 * table appears in the library with nothing in this repo to notice. The
 * symptom is not a startup error — the adapter builds queries from the
 * library's field list, so a missing column surfaces as a 500 the first time
 * someone runs the flow that touches it, which for the OAuth tables means the
 * first MCP client to connect after a deploy.
 *
 * So this runs the comparison instead, offline and on every `pnpm test`:
 * `getAuthTables()` is the same function the CLI generates from, and
 * `getTableConfig()` is what Drizzle actually knows about our tables.
 *
 * When it fails, the fix is nearly always to edit
 * `packages/db/src/schema/auth.ts` and run `pnpm db:generate` — not to relax
 * the assertion. The exception is a deliberate divergence, which belongs in
 * `INTENTIONAL_NULLABLE` below with the reason attached.
 */

/**
 * Fields Better Auth marks required that we store nullable, on purpose. Each
 * entry needs a reason; an empty set is the healthy state.
 */
const INTENTIONAL_NULLABLE = new Set<string>([]);

/** Drizzle names the implicit primary key; Better Auth takes it as a given. */
const IMPLICIT_COLUMNS = new Set(["id"]);

const expected = getAuthTables({ plugins: authPlugins("http://localhost:4000") });
const tables: Record<string, PgTable | undefined> = authSchemaMap;

describe("better-auth schema", () => {
  test("every model Better Auth declares has a table behind it", () => {
    // Catches the case that actually bites on an upgrade: a plugin gains a
    // table (1.7's oauth provider adds four) and nothing here knows.
    assert.deepEqual(
      Object.keys(expected).sort(),
      Object.keys(authSchemaMap).sort(),
      "authSchemaMap is out of step with the models the installed plugins declare",
    );
  });

  for (const [model, definition] of Object.entries(expected)) {
    const table = tables[model];
    if (!table) continue; // Already reported by the coverage test above.

    describe(model, () => {
      const config = getTableConfig(table);
      // Column `.name` is the property key here: casing is applied by the
      // Drizzle client (`casing: "snake_case"`), not baked into the schema, so
      // these compare directly against Better Auth's camelCase field names.
      const columns = new Map(config.columns.map((c) => [c.name, c]));

      test("columns match the declared fields", () => {
        const declared = Object.keys(definition.fields).sort();
        const actual = [...columns.keys()]
          .filter((name) => !IMPLICIT_COLUMNS.has(name))
          .sort();
        assert.deepEqual(actual, declared, `${config.name} column set`);
      });

      for (const [field, spec] of Object.entries(definition.fields)) {
        const column = columns.get(field);
        if (!column) continue; // Already reported by the column-set test.

        test(`${field} is stored as declared`, () => {
          const key = `${model}.${field}`;
          if (spec.required === false) {
            // Optional means the adapter may leave the field out of an insert.
            // NOT NULL is still fine if the column defaults — that is stricter
            // than asked for, and Postgres fills the gap.
            assert.ok(
              !column.notNull || column.hasDefault,
              `${key} is optional in Better Auth but NOT NULL with no default`,
            );
          } else if (INTENTIONAL_NULLABLE.has(key)) {
            assert.equal(column.notNull, false, `${key} is an intentional exception`);
          } else {
            assert.equal(column.notNull, true, `${key} must be NOT NULL`);
          }
          assert.equal(column.isUnique, spec.unique === true, `${key} uniqueness`);
        });
      }

      // Postgres indexes a unique constraint and a primary key on its own, but
      // never a foreign key — so every field Better Auth marks `index` needs
      // one written out, or the lookup it exists for is a sequential scan.
      const indexed = Object.entries(definition.fields)
        .filter(([, spec]) => spec.index)
        .map(([field]) => field);

      for (const field of indexed) {
        test(`${field} is indexed`, () => {
          const covered =
            columns.get(field)?.isUnique === true ||
            config.indexes.some((index) =>
              index.config.columns.some((c) => "name" in c && c.name === field),
            );
          assert.ok(covered, `${config.name}.${field} needs an index`);
        });
      }
    });
  }
});
