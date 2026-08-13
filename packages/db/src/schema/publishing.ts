import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Actor, PostContent } from "@zest/shared";
import {
  inboundKindEnum,
  inboundStatusEnum,
  postStatusEnum,
  sentimentEnum,
} from "./enums.ts";
import { workspaces } from "./workspace.ts";

export const linkedAccounts = pgTable(
  "linked_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Connector registry id: "pomelo" | "bluesky" | "mastodon" | … */
    connectorId: text().notNull(),
    handle: text().notNull(),
    displayName: text(),
    avatarUrl: text(),
    profileUrl: text(),
    externalId: text(),
    /**
     * Where this account lives: the Mastodon instance, the Pomelo API base.
     * Federated and self-hosted platforms have no single well-known host.
     */
    endpoint: text(),
    /** AES-256-GCM ciphertext, never plaintext. */
    accessTokenEnc: text(),
    refreshTokenEnc: text(),
    tokenExpiresAt: timestamp({ withTimezone: true }),
    isActive: text().notNull().default("true"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  // Deliberately not unique on (workspace, connector): one workspace may run
  // several handles on the same platform, each with its own persona.
  (t) => [index("linked_accounts_workspace_idx").on(t.workspaceId, t.connectorId)],
);

export const posts = pgTable(
  "posts",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid()
      .notNull()
      .references(() => linkedAccounts.id, { onDelete: "cascade" }),
    status: postStatusEnum().notNull().default("draft"),
    content: jsonb().$type<PostContent>().notNull(),
    /** What the agent proposed; becomes scheduledAt once a human approves. */
    suggestedSlotAt: timestamp({ withTimezone: true }),
    scheduledAt: timestamp({ withTimezone: true }),
    publishedAt: timestamp({ withTimezone: true }),
    externalId: text(),
    externalUrl: text(),
    errorMessage: text(),
    reasoning: text(),
    createdByActor: jsonb().$type<Actor>().notNull(),
    agentRunId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("posts_workspace_status_idx").on(t.workspaceId, t.status),
    // Drives the due-post sweep; the worker claims rows off this index.
    index("posts_due_idx").on(t.status, t.scheduledAt),
  ],
);

export const inboundItems = pgTable(
  "inbound_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid()
      .notNull()
      .references(() => linkedAccounts.id, { onDelete: "cascade" }),
    kind: inboundKindEnum().notNull(),
    externalId: text().notNull(),
    authorHandle: text().notNull(),
    authorName: text(),
    authorAvatarUrl: text(),
    text: text().notNull(),
    sentiment: sentimentEnum(),
    postId: uuid().references(() => posts.id, { onDelete: "set null" }),
    status: inboundStatusEnum().notNull().default("new"),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("inbound_account_status_idx").on(t.accountId, t.status),
    index("inbound_external_idx").on(t.accountId, t.externalId),
  ],
);

/** Reply drafts reuse the post state machine so approval works identically. */
export const replyDrafts = pgTable(
  "reply_drafts",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    inboundItemId: uuid()
      .notNull()
      .references(() => inboundItems.id, { onDelete: "cascade" }),
    status: postStatusEnum().notNull().default("pending_approval"),
    content: jsonb().$type<PostContent>().notNull(),
    reasoning: text(),
    externalId: text(),
    externalUrl: text(),
    errorMessage: text(),
    createdByActor: jsonb().$type<Actor>().notNull(),
    agentRunId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reply_drafts_workspace_status_idx").on(t.workspaceId, t.status)],
);
