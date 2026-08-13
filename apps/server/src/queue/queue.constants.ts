/**
 * Every unit of real work is a job, even when a cron could have done it inline.
 * That buys retries, a visible Bull Board entry, and horizontal scale for free.
 */
export const QUEUE_PUBLISH = "publish";
export const QUEUE_AGENT_RUN = "agent-run";
export const QUEUE_NOTIFY = "notify";
export const QUEUE_INGEST = "ingest";
export const QUEUE_SIMULATOR = "simulator";

export const ALL_QUEUES = [
  QUEUE_PUBLISH,
  QUEUE_AGENT_RUN,
  QUEUE_NOTIFY,
  QUEUE_INGEST,
  QUEUE_SIMULATOR,
] as const;

export type QueueName = (typeof ALL_QUEUES)[number];

/** Repeatable jobs only enqueue work; they never do the work themselves. */
export const REPEATABLE_JOBS = {
  /** Sweeps posts whose scheduled time has arrived. */
  sweepDuePosts: { queue: QUEUE_PUBLISH, name: "sweep-due-posts", pattern: "* * * * *" },
  /** Releases simulated engagement events whose sim-time has come. */
  simulatorTick: { queue: QUEUE_SIMULATOR, name: "tick", pattern: "* * * * *" },
  /** Pulls engagement from real platforms. */
  pollEngagement: { queue: QUEUE_INGEST, name: "poll-engagement", pattern: "*/5 * * * *" },
  /** Re-enqueues anything the publish sweep dropped (DB/Redis divergence). */
  reconcile: { queue: QUEUE_PUBLISH, name: "reconcile", pattern: "*/10 * * * *" },
} as const;
