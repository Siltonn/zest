import { BullModule } from "@nestjs/bullmq";
import { Global, Module } from "@nestjs/common";
import { loadEnv } from "../config.js";
import { ALL_QUEUES } from "./queue.constants.js";

function redisConnection() {
  const url = new URL(loadEnv().REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: url.password } : {}),
  };
}

/**
 * Registered in every mode: the API role needs producers to enqueue work, the
 * worker role needs the same queues to consume it.
 */
@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: redisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1_000 },
      },
    }),
    ...ALL_QUEUES.map((name) => BullModule.registerQueue({ name })),
  ],
  exports: [BullModule],
})
export class QueueModule {}
