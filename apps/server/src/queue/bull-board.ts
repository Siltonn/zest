import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import type { INestApplication } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { ALL_QUEUES } from "./queue.constants.js";

/**
 * The queue dashboard at /admin/queues.
 *
 * Every unit of real work in Zest is a job, so this is where you find out why
 * a post did not publish — which beats reading logs, and is the first thing to
 * check when the loop appears stuck.
 */
export function mountBullBoard(app: INestApplication): void {
  const adapter = new ExpressAdapter();
  adapter.setBasePath("/admin/queues");

  const queues = ALL_QUEUES.map((name) =>
    app.get<Queue>(getQueueToken(name), { strict: false }),
  ).filter(Boolean);

  createBullBoard({
    queues: queues.map((queue) => new BullMQAdapter(queue)),
    serverAdapter: adapter,
  });

  app.use("/admin/queues", adapter.getRouter());
}
