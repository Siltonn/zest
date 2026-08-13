import type { Queue } from "bullmq";

/**
 * Enqueue a job with a stable id, allowing retries.
 *
 * A custom `jobId` deduplicates concurrent enqueues — two cron ticks racing on
 * the same post collapse into one job. But BullMQ retains completed and failed
 * jobs, and adding an id that already exists is silently a no-op. That turns
 * the dedup into a permanent block: a failed publish could never be retried,
 * because its old job still occupies the id.
 *
 * So we clear a *finished* job with that id first. `remove()` refuses to touch
 * an active job, which is exactly right — an in-flight publish should not be
 * disturbed, and the duplicate is dropped as intended.
 *
 * None of this is the correctness guarantee. That lives in the database: the
 * conditional claim on `posts`, and the `status = 'approved'` filter on reply
 * drafts. This only avoids pointless work.
 */
export async function enqueueUnique(
  queue: Queue,
  name: string,
  data: Record<string, unknown>,
  jobId: string,
): Promise<void> {
  const existing = await queue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();
    if (state === "active" || state === "waiting" || state === "delayed") {
      // Already queued or running — leave it alone.
      return;
    }
    await existing.remove().catch(() => undefined);
  }

  await queue.add(name, data, { jobId });
}
