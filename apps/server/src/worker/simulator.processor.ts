import { buildPersonaReplyGenerator } from "./persona-replies.js";
import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { Redis } from "ioredis";
import { eq, schema, type Database } from "@zest/db";
import { emit } from "@zest/core";
import {
  advanceClock,
  advanceTrends,
  releaseDueEvents,
  tickAmount,
  readClock,
} from "@zest/simulator";
import { QUEUE_INGEST, QUEUE_SIMULATOR } from "../queue/queue.constants.js";
import { DATABASE } from "../infra/database.module.js";
import { REDIS_PUB } from "../infra/redis.module.js";

/**
 * Drives Pomelo forward.
 *
 * On each tick the workspace clock advances (by real elapsed time, or by a day
 * when someone hits fast-forward), reactions whose moment has come are applied,
 * and each one is pushed to the browser so the feed visibly comes alive rather
 * than silently changing behind a refresh.
 */
@Processor(QUEUE_SIMULATOR)
export class SimulatorProcessor extends WorkerHost {
  private readonly logger = new Logger(SimulatorProcessor.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS_PUB) private readonly redis: Redis,
    @InjectQueue(QUEUE_INGEST) private readonly ingestQueue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    const explicit = job.data?.workspaceId as string | undefined;
    const workspaces = explicit
      ? [{ id: explicit }]
      : await this.db.select({ id: schema.workspaces.id }).from(schema.workspaces);

    let released = 0;

    for (const workspace of workspaces) {
      // A scheduled tick moves the clock; a fast-forward has already moved it.
      if (!explicit) {
        const clock = await readClock(this.db, workspace.id);
        await advanceClock(this.db, workspace.id, tickAmount(clock, 60_000));
      }

      const events = await releaseDueEvents(this.db, workspace.id, {
        limit: 300,
        generateReply: buildPersonaReplyGenerator(),
      });
      released += events.length;

      for (const event of events) {
        await emit(this.redis, {
          type: "sim.event",
          workspaceId: workspace.id,
          postId: event.postId,
          kind: event.kind,
          actorHandle: event.actorHandle,
          text: event.text,
        });
      }

      if (events.length > 0) {
        // Fold the new engagement into Zest through the ordinary connector
        // ingestion path, exactly as a real platform's numbers would arrive.
        await this.ingestQueue.add("poll-engagement", { workspaceId: workspace.id });

        const clock = await readClock(this.db, workspace.id);
        await emit(this.redis, {
          type: "clock.advanced",
          workspaceId: workspace.id,
          simNow: clock.simNow.toISOString(),
        });
      }
    }

    if (job.name === "advance-trends" || released > 50) {
      await advanceTrends(this.db);
    }

    return { released };
  }
}
