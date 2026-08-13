import { z } from "zod";

/**
 * Domain events. The state machine and simulator publish them; SSE, the
 * notifier and (later) outbound webhooks subscribe. Adding a consumer never
 * requires touching the producer.
 */

export const domainEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inbox.new"),
    workspaceId: z.string(),
    itemKind: z.enum(["post", "reply", "memory", "autonomy_request", "plan"]),
    entityId: z.string(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("post.status_changed"),
    workspaceId: z.string(),
    postId: z.string(),
    from: z.string(),
    to: z.string(),
    actorKind: z.string(),
  }),
  z.object({
    type: z.literal("sim.event"),
    workspaceId: z.string(),
    postId: z.string(),
    kind: z.string(),
    actorHandle: z.string().optional(),
    text: z.string().optional(),
  }),
  z.object({
    type: z.literal("metric.updated"),
    workspaceId: z.string(),
    accountId: z.string(),
    postId: z.string().optional(),
  }),
  z.object({
    type: z.literal("run.progress"),
    workspaceId: z.string(),
    runId: z.string(),
    role: z.string().optional(),
    phase: z.string(),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal("clock.advanced"),
    workspaceId: z.string(),
    simNow: z.string(),
  }),
]);

export type DomainEvent = z.infer<typeof domainEventSchema>;

export const channelFor = (workspaceId: string): string => `zest:ws:${workspaceId}`;

/** Minimal contract so core does not depend on ioredis directly. */
export interface EventPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export async function emit(
  publisher: EventPublisher,
  event: DomainEvent,
): Promise<void> {
  await publisher.publish(channelFor(event.workspaceId), JSON.stringify(event));
}

export function parseEvent(raw: string): DomainEvent | null {
  try {
    const parsed = domainEventSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
