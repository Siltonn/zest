# ADR 002 — Publishing exactly once

**Status:** Accepted · **Date:** 2026-08-13

## Context

A scheduler that occasionally posts twice is worse than useless — it damages the account
it was meant to help, publicly, and the user finds out from their followers. This is the
one correctness property in Zest that has to hold under every failure mode: overlapping
cron ticks, a queue redelivering a job, a worker dying mid-publish, Redis restored from a
snapshot, two workers scaled out behind a load balancer.

The prior art we started from (a Next.js scheduler using Inngest) fanned out one event per
due post without claiming anything first. A publish slower than the cron interval would be
picked up twice.

## Decision

**The guarantee lives in Postgres, not in the queue.**

The sweep enqueues one job per due post, keyed by post id. The handler then claims the row:

```sql
UPDATE posts SET status = 'publishing'
WHERE id = $1 AND status = 'scheduled'
RETURNING *
```

Zero rows returned means someone else got there first, and the handler exits quietly —
that is the guard working, not an error. Only the worker whose `UPDATE` matched proceeds to
talk to the platform.

Supporting pieces:

- **`jobId` deduplication** in BullMQ collapses duplicate enqueues. This is an optimisation,
  not the guarantee — it reduces wasted work, and we do not depend on it.
- **A reconcile job** every ten minutes returns posts stuck in `publishing` past a grace
  period back to `scheduled`, so a worker killed mid-flight does not strand a post
  invisibly. It also expires proposals nobody reviewed.
- **Nothing auto-publishes after expiry.** An unreviewed proposal goes to `expired` and back
  to the agent to re-plan, rather than going out late and unread.

## Why not rely on the queue

Queue-level exactly-once is a property of the broker's storage, and ours is Redis — which
can be configured without persistence, restored from a snapshot, or flushed. A job losing
its dedup key would then permit a second publish. Postgres holds the post row and the
transaction that moves it; making the row itself the arbiter means the worst a Redis
failure can cost is a delayed post, never a duplicated one.

The DB/Redis gap runs the other way too: a post can be scheduled in a committed transaction
and still lose its queue job if Redis blips. The reconcile sweep covers that, which is why
it re-scans rather than trusting the queue to be complete.

## Consequences

- Publishing costs one extra `UPDATE` per post. Irrelevant at this scale.
- Losing Redis costs a delay, not a duplicate.
- Scaling to N workers needs no coordination, leader election, or locks.
- This is verified by an integration test that runs ten concurrent claims against a real
  Postgres and asserts exactly one wins (`packages/core/src/claim.integration.test.ts`).
  A unit test with a mocked database would prove nothing here — the property depends on how
  Postgres actually serialises concurrent conditional updates.

## Related

Two bugs found while verifying this end to end, both worth recording because neither was
visible from reading the code:

1. Passing a JS `Date` into a raw drizzle `sql` template fails under the postgres.js driver.
   The due-post sweep threw once a minute and nothing surfaced it. All date and array
   comparisons now use typed operators (`lte`, `gte`, `lt`, `inArray`).
2. BullMQ rejects colons in custom job ids, so the fan-out silently enqueued nothing.
