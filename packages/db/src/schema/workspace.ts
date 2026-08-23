import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Actor } from "@zest/shared";
import { memoryKindEnum, memoryScopeEnum } from "./enums.ts";

export const workspaces = pgTable("workspaces", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  /** Display and planning zone. Storage is always UTC. */
  timezone: text().notNull().default("UTC"),
  /** `daily` | `weekdays` | `weekly` | a raw cron expression. */
  kpiConfig: jsonb().$type<{ goal?: string; targets?: Record<string, number> }>(),
  /** Demo mode speeds up the simulated clock so a day passes in seconds. */
  demoClockMultiplier: integer().notNull().default(1),
  simClockAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Agent memory as versioned markdown. Workspace docs hold the brand facts and
 * strategy; per account there is one `persona` playbook (voice, positioning,
 * pillars, red lines) plus optionally account-scoped `learnings`. Which kinds
 * may take an accountId is enforced by `assertMemoryScope` in @zest/core, not
 * here — the column stays kind-agnostic.
 */
export const memoryDocs = pgTable(
  "memory_docs",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scope: memoryScopeEnum().notNull(),
    accountId: uuid(),
    kind: memoryKindEnum().notNull(),
    version: integer().notNull().default(1),
    contentMd: text().notNull(),
    updatedByActor: jsonb().$type<Actor>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("memory_docs_lookup_idx").on(t.workspaceId, t.kind, t.accountId, t.version),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text().notNull(),
    hashedKey: text().notNull().unique(),
    scopes: jsonb().$type<string[]>().notNull().default([]),
    lastUsedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_keys_workspace_idx").on(t.workspaceId)],
);
