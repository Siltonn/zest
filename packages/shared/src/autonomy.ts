import { z } from "zod";

/**
 * Actions that can be delegated. Each mutating agent tool maps to exactly one
 * of these, and the autonomy guard decides whether the tool proposes or acts.
 */
export const AUTONOMY_ACTIONS = [
  "propose_post",
  "schedule_post",
  "send_reply",
  "update_memory",
  "engagement_automation",
] as const;

export type AutonomyAction = (typeof AUTONOMY_ACTIONS)[number];

export const autonomyActionSchema = z.enum(AUTONOMY_ACTIONS);

/** `approve` routes through the inbox; `auto` lets the agent act directly. */
export const autonomyModeSchema = z.enum(["approve", "auto"]);
export type AutonomyMode = z.infer<typeof autonomyModeSchema>;

export const autonomyConditionsSchema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]).optional(),
  maxPerDay: z.number().int().positive().optional(),
});

export type AutonomyConditions = z.infer<typeof autonomyConditionsSchema>;
