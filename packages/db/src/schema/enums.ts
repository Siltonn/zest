import { pgEnum } from "drizzle-orm/pg-core";
import { AUTONOMY_ACTIONS, POST_STATUSES } from "@zest/shared";

export const postStatusEnum = pgEnum("post_status", POST_STATUSES);

export const autonomyActionEnum = pgEnum("autonomy_action", AUTONOMY_ACTIONS);

export const autonomyModeEnum = pgEnum("autonomy_mode", ["approve", "auto"]);

export const memoryScopeEnum = pgEnum("memory_scope", ["workspace", "account"]);

export const memoryKindEnum = pgEnum("memory_kind", [
  "brand_brief",
  "strategy",
  "learnings",
  "persona",
  // The analyst's weekly write-up. Versioned like the rest so past reports stay
  // readable instead of being overwritten each week.
  "report",
]);

export const agentRoleEnum = pgEnum("agent_role", [
  "researcher",
  "strategist",
  "copywriter",
  "community",
  "analyst",
]);

export const agentTriggerEnum = pgEnum("agent_trigger", [
  "cron_plan",
  "event_reply",
  "cron_analyze",
  "chat",
  "mcp",
  "manual",
]);

export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "running",
  "succeeded",
  "failed",
]);

export const inboundKindEnum = pgEnum("inbound_kind", [
  "reply",
  "mention",
  "dm",
]);

export const inboundStatusEnum = pgEnum("inbound_status", [
  "new",
  "triaged",
  "replied",
  "ignored",
]);

export const sentimentEnum = pgEnum("sentiment", [
  "positive",
  "neutral",
  "negative",
  "hostile",
]);

export const notificationKindEnum = pgEnum("notification_kind", [
  "email",
  "slack",
  "discord",
]);

export const digestModeEnum = pgEnum("digest_mode", ["instant", "daily"]);

export const metricEnum = pgEnum("metric", [
  "impressions",
  "likes",
  "reposts",
  "replies",
  "followers",
]);

export const simEventKindEnum = pgEnum("sim_event_kind", [
  "impression",
  "like",
  "repost",
  "reply",
  "follow",
]);

export const automationKindEnum = pgEnum("automation_kind", [
  "auto_plug",
  "auto_reply",
  "auto_dm",
]);


export const changeRequestKindEnum = pgEnum("change_request_kind", [
  "memory",
  "autonomy",
]);

export const changeRequestStatusEnum = pgEnum("change_request_status", [
  "pending",
  "approved",
  "rejected",
]);

export const planStatusEnum = pgEnum("plan_status", [
  "active",
  "paused",
  "archived",
]);

export const planItemStatusEnum = pgEnum("plan_item_status", [
  "planned",
  "written",
  "skipped",
]);

export const planKindEnum = pgEnum("plan_kind", ["fresh", "evergreen"]);
