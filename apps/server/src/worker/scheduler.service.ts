import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  QUEUE_INGEST,
  QUEUE_PUBLISH,
  QUEUE_SIMULATOR,
  REPEATABLE_JOBS,
} from "../queue/queue.constants.js";

/**
 * Registers the recurring timers on boot. BullMQ keys repeatable jobs by
 * name+pattern, so re-registering on every restart is idempotent rather than
 * additive.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectQueue(QUEUE_PUBLISH) private readonly publishQueue: Queue,
    @InjectQueue(QUEUE_SIMULATOR) private readonly simulatorQueue: Queue,
    @InjectQueue(QUEUE_INGEST) private readonly ingestQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    const queues: Record<string, Queue> = {
      [QUEUE_PUBLISH]: this.publishQueue,
      [QUEUE_SIMULATOR]: this.simulatorQueue,
      [QUEUE_INGEST]: this.ingestQueue,
    };

    for (const job of Object.values(REPEATABLE_JOBS)) {
      const queue = queues[job.queue];
      if (!queue) continue;
      await queue.upsertJobScheduler(job.name, { pattern: job.pattern });
      this.logger.log(`scheduled ${job.queue}/${job.name} (${job.pattern})`);
    }
  }
}
