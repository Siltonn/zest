import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { eq, schema, type Database } from "@zest/db";
import { webhooks, type WebhookDelivery } from "@zest/core";
import { DATABASE } from "../infra/database.module.js";
import { QUEUE_WEBHOOK } from "../queue/queue.constants.js";

/**
 * Delivers one webhook.
 *
 * Throws on failure so BullMQ applies the backoff configured at enqueue time —
 * the retry policy belongs to the queue, not to a hand-rolled loop in here.
 * The outcome is recorded either way, so the settings page can show an endpoint
 * that has stopped answering instead of failing silently.
 */
@Processor(QUEUE_WEBHOOK)
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    const { endpointId, delivery } = job.data as {
      endpointId: string;
      delivery: WebhookDelivery;
    };

    const endpoint = await this.db.query.webhookEndpoints.findFirst({
      where: eq(schema.webhookEndpoints.id, endpointId),
    });

    // Deleted or disabled between enqueue and delivery. Not an error — dropping
    // it is exactly what the operator asked for.
    if (!endpoint || endpoint.isActive !== "true") return { delivered: false };

    const outcome = await webhooks.deliver(endpoint, delivery);
    await webhooks.recordOutcome(this.db, endpointId, outcome);

    if (!outcome.ok) {
      const detail = outcome.status === 0 ? outcome.error : `HTTP ${outcome.status}`;
      this.logger.warn(`${endpoint.url} rejected ${delivery.type}: ${detail}`);
      throw new Error(`Webhook delivery failed: ${detail}`);
    }

    return { delivered: true, status: outcome.status };
  }
}
