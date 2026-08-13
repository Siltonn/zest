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
  automationKindEnum,
  changeRequestKindEnum,
  changeRequestStatusEnum,
  agentRunStatusEnum,
  agentTriggerEnum,
  autonomyActionEnum,
  autonomyModeEnum,
  digestModeEnum,
  messageRoleEnum,
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
    /** Which plan this stage served, and which account it wrote for. */
    planId: uuid(),
    accountId: uuid(),
    /**
     * The role's final text. Stages run as separate jobs now, so the next one
     * reads its input from here rather than being handed it in memory — which
     * is what makes a single stage retryable on its own.
     */
    output: text(),
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

/**
 * Rule-based engagement actions (auto-plug, auto-reply, auto-DM). These are
 * deliberately rules rather than agent judgement — they should be predictable —
 * but they still pass through the autonomy guard before firing.
 */
export const engagementAutomations = pgTable(
  "engagement_automations",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid().references(() => linkedAccounts.id, { onDelete: "cascade" }),
    kind: automationKindEnum().notNull(),
    trigger: jsonb()
      .$type<{
        threshold?: number;
        sentiment?: "positive" | "neutral" | "negative";
        keywords?: string[];
      }>()
      .notNull(),
    template: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("engagement_automations_workspace_idx").on(t.workspaceId)],
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

/**
 * Chat conversations.
 *
 * Without these every turn was standalone — the agent could not follow up on
 * what it had just said, which is not a conversation. Messages carry the tool
 * calls that produced them so the UI can show its work, and the ids of anything
 * it proposed so those can be approved inline rather than sending the operator
 * off to the inbox.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Taken from the opening message; renameable later. */
    title: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversations_workspace_idx").on(t.workspaceId, t.updatedAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid().primaryKey().defaultRandom(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRoleEnum().notNull(),
    content: text().notNull(),
    /** Which tools ran, so the UI can show what it actually did. */
    toolCalls: jsonb().$type<{ tool: string; summary?: string }[]>().notNull().default([]),
    /** Posts and replies proposed during this turn, for inline approval. */
    proposals: jsonb()
      .$type<{ kind: "post" | "reply"; id: string }[]>()
      .notNull()
      .default([]),
    agentRunId: uuid().references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

/**
 * Changes the agent wants to make to itself, awaiting a human decision.
 *
 * Posts and replies are domain rows with their own state machine, but a
 * proposed rewrite of the strategy — or a request to stop asking permission —
 * had nowhere to live. They were announced to the inbox and then invisible,
 * which made two thirds of the approval story a promise the UI could not keep.
 */
export const changeRequests = pgTable(
  "change_requests",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: changeRequestKindEnum().notNull(),
    status: changeRequestStatusEnum().notNull().default("pending"),
    /** Human-readable one-liner for the inbox card. */
    summary: text().notNull(),
    /** Why the agent wants this. */
    rationale: text(),
    /**
     * memory: { kind, accountId?, contentMd, before? }
     * autonomy: { action, connectorId?, accountId? }
     */
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    agentRunId: uuid().references(() => agentRuns.id, { onDelete: "set null" }),
    resolvedBy: text(),
    resolvedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("change_requests_pending_idx").on(t.workspaceId, t.status)],
);
