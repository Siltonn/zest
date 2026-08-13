import { Global, Module, type OnApplicationShutdown } from "@nestjs/common";
import { Redis } from "ioredis";
import { loadEnv } from "../config.js";

export const REDIS_PUB = Symbol("REDIS_PUB");
export const REDIS_SUB = Symbol("REDIS_SUB");

/**
 * Two connections: a subscriber cannot issue ordinary commands once it enters
 * subscribe mode, so publishing needs its own client.
 */
@Global()
@Module({
  providers: [
    { provide: REDIS_PUB, useFactory: () => new Redis(loadEnv().REDIS_URL) },
    {
      provide: REDIS_SUB,
      useFactory: () => new Redis(loadEnv().REDIS_URL),
    },
  ],
  exports: [REDIS_PUB, REDIS_SUB],
})
export class RedisModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    // ioredis clients are closed by the DI container teardown in tests; in
    // production the process exit closes them. Nothing to do here yet.
  }
}
