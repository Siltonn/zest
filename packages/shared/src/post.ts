import { z } from "zod";

/**
 * The publishing state machine. Two things are load-bearing here:
 *  - `pending_approval` is a real state, not a flag, so the inbox can list,
 *    filter, notify on, and expire proposals like any other domain data.
 *  - `publishing` exists so a worker can claim a row before it talks to a
 *    platform; without that claim two overlapping ticks can double-post.
 */
export const POST_STATUSES = [
  "draft",
  "pending_approval",
  "needs_changes",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "rejected",
  "expired",
  "canceled",
] as const;

export type PostStatus = (typeof POST_STATUSES)[number];

export const postStatusSchema = z.enum(POST_STATUSES);

export const mediaRefSchema = z.object({
  url: z.string(),
  altText: z.string().optional(),
  mimeType: z.string().optional(),
});

export const postContentSchema = z.object({
  text: z.string(),
  media: z.array(mediaRefSchema).default([]),
  /**
   * Follow-up parts of a thread, text-only for now.
   *
   * A thread is one domain object, not N linked posts: one approval, one
   * calendar entry, one publish claim. Splitting it into rows would make the
   * operator approve five things to say one thing, and the double-post claim
   * would have to span all of them. The chain is a publishing detail — part one
   * goes out with `publish()`, the rest with `reply()` to the previous part.
   */
  thread: z.array(z.string().min(1)).optional(),
});

export type PostContent = z.infer<typeof postContentSchema>;

/** Statuses a post can still be edited or canceled from. */
export const PRE_PUBLISH_STATUSES: readonly PostStatus[] = [
  "draft",
  "pending_approval",
  "needs_changes",
  "approved",
  "scheduled",
];

export const TERMINAL_STATUSES: readonly PostStatus[] = [
  "published",
  "rejected",
  "canceled",
];
