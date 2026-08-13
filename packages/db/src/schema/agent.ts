import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Actor, AutonomyConditions } from "@zest/shared";
import {
  agentRoleEnum,
  agentRunStatusEnum,
  agentTriggerEnum,
  autonomyActionEnum,
  autonomyModeEnum,
  digestModeEnum,
  metricEnum,
  notificationKindEnum,
} from "./enums.ts";
import { linkedAccounts, posts } from "./publishing.ts";
import { workspaces } from "./workspace.ts";

/**
 * One row per agent invocation. The transcript is what makes a proposal
 * explainable after the fact: the inbox links here so a reviewer can see which
 * tools ran and what data the agent looked at before it wrote the draft.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: agentRoleEnum(),
    trigger: agentTriggerEnum().notNull(),
    status: agentRunStatusEnum().notNull().default("running"),
    model: text(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    costUsd: numeric({ precision: 10, scale: 6 }).notNull().default("0"),
    transcript: jsonb().$type<unknown[]>().notNull().default([]),
    errorMessage: text(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index("agent_runs_workspace_idx").on(t.workspaceId, t.startedAt)],
);

/**
 * Graduated autonomy. Absent a matching rule a mutating tool downgrades to a
 * proposal; with `auto` the same tool executes directly. The tool code and the
 * prompt never change — only the trust level does.
 */
export const autonomyRules = pgTable(
  "autonomy_rules",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    action: autonomyActionEnum().notNull(),
    connectorId: text(),
    accountId: uuid().references(() => linkedAccounts.id, { onDelete: "cascade" }),
    conditions: jsonb().$type<AutonomyConditions>(),
    mode: autonomyModeEnum().notNull().default("approve"),
    grantedBy: text(),
    grantedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("autonomy_rules_lookup_idx").on(t.workspaceId, t.action)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityType: text().notNull(),
    entityId: uuid().notNull(),
    action: text().notNull(),
    fromStatus: text(),
    toStatus: text(),
    actor: jsonb().$type<Actor>().notNull(),
    diff: jsonb(),
    agentRunId: uuid().references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_workspace_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const metricPoints = pgTable(
  "metric_points",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid()
      .notNull()
      .references(() => linkedAccounts.id, { onDelete: "cascade" }),
    postId: uuid().references(() => posts.id, { onDelete: "cascade" }),
    metric: metricEnum().notNull(),
    value: integer().notNull(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("metric_points_lookup_idx").on(t.accountId, t.metric, t.at)],
);

export const notificationTargets = pgTable(
  "notification_targets",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: notificationKindEnum().notNull(),
    config: jsonb().$type<{ email?: string; webhookUrl?: string }>().notNull(),
    digestMode: digestModeEnum().notNull().default("instant"),
    quietHours: jsonb().$type<{ start: number; end: number }>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notification_targets_workspace_idx").on(t.workspaceId)],
);
