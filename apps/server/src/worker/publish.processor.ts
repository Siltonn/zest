import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { QUEUE_PUBLISH } from "../queue/queue.constants.js";

/**
 * Two job shapes share this queue:
 *  - `sweep-due-posts` finds posts whose time has come and fans out one
 *    `publish-post` job per post, keyed by post id so a slow publish cannot be
 *    double-enqueued by the next tick.
 *  - `publish-post` claims the row with a conditional UPDATE before it talks to
 *    the platform. The claim, not the queue, is what makes double-posting
 *    impossible.
 *
 * M2 fills in the real bodies once the state machine and connectors exist.
 */
@Processor(QUEUE_PUBLISH)
export class PublishProcessor extends WorkerHost {
  private readonly logger = new Logger(PublishProcessor.name);

  async process(job: Job): Promise<void> {
    this.logger.debug(`${job.name} (${job.id})`);
  }
}
