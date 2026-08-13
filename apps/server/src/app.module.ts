import { type DynamicModule, Module } from "@nestjs/common";
import { ApiModule } from "./api/api.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { runsApi, runsWorker, type ServerMode } from "./config.js";
import { DatabaseModule } from "./infra/database.module.js";
import { NotifierModule } from "./infra/notifier.module.js";
import { RedisModule } from "./infra/redis.module.js";
import { QueueModule } from "./queue/queue.module.js";
import { WorkerModule } from "./worker/worker.module.js";

@Module({})
export class AppModule {
  static forMode(mode: ServerMode): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule,
        RedisModule,
        QueueModule,
        NotifierModule,
        // Auth is needed in both roles: the API to verify callers, the worker
        // because its modules share the same DI graph.
        AuthModule,
        ...(runsApi(mode) ? [ApiModule] : []),
        ...(runsWorker(mode) ? [WorkerModule] : []),
      ],
    };
  }
}
