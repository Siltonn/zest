import { Module } from "@nestjs/common";
import { PublishProcessor } from "./publish.processor.js";
import { SchedulerService } from "./scheduler.service.js";

/**
 * Background role. Only loaded when MODE is `worker` or `all`, so an API-only
 * container never starts consuming jobs.
 */
@Module({
  providers: [SchedulerService, PublishProcessor],
})
export class WorkerModule {}
