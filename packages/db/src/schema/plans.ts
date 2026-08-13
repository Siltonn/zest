import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { planItemStatusEnum, planStatusEnum } from "./enums.ts";
import { workspaces } from "./workspace.ts";
import { linkedAccounts, posts } from "./publishing.ts";

/**
 * A content programme with its own cadence.
 *
 * The planning cadence used to sit on the workspace, which said every account
 * moves at the same speed — wrong for a founder account riffing daily beside a
 * brand account posting twice a week. Moving it here rather than onto the
 * account is deliberate: a plan already names the accounts it targets, so
 * per-account rhythm falls out of it, and a launch week spanning both accounts
 * stays expressible. Nesting plans under accounts would have lost exactly the
 * case that justifies sharing research across them.
 */
export const plans = pgTable(
  "plans",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** What this programme is for, in the operator's words. Fed to the strategist. */
    objective: text(),
    /** A named cadence (daily/weekdays/weekly/manual) or a raw cron expression. */
    schedule: text().notNull().default("weekly"),
    status: planStatusEnum().notNull().default("active"),
    /** Campaigns are time-boxed; an always-on programme leaves these null. */
    startsAt: timestamp({ withTimezone: true }),
    endsAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("plans_workspace_idx").on(t.workspaceId, t.status)],
);

/** Which accounts a plan writes for. Many-to-many so campaigns can span them. */
export const planAccounts = pgTable(
  "plan_accounts",
  {
    planId: uuid()
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    accountId: uuid()
      .notNull()
      .references(() => linkedAccounts.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.planId, t.accountId] })],
);

/**
 * One intended post, before anyone has written it.
 *
 * This is the handoff between the strategist and the copywriter, and it used to
 * be a string pasted into a prompt — which meant the plan could not be read,
 * edited, retried, or traced to the posts it produced. As rows it is all four,
 * and reviewing "six topics next week" costs a fraction of reviewing six drafts.
 */
export const planItems = pgTable(
  "plan_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    planId: uuid()
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid()
      .notNull()
      .references(() => linkedAccounts.id, { onDelete: "cascade" }),
    topic: text().notNull(),
    /** The angle for this account specifically — what makes it not the other one. */
    angle: text(),
    suggestedSlotAt: timestamp({ withTimezone: true }),
    status: planItemStatusEnum().notNull().default("planned"),
    /** Set once the copywriter turns this into a proposal. */
    postId: uuid().references(() => posts.id, { onDelete: "set null" }),
    agentRunId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Drives the copywriter fan-out: unwritten items for one account.
    index("plan_items_pending_idx").on(t.planId, t.accountId, t.status),
  ],
);
