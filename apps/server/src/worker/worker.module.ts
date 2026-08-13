import { Module } from "@nestjs/common";
import { AgentProcessor } from "./agent.processor.js";
import { IngestProcessor } from "./ingest.processor.js";
import { PublishProcessor } from "./publish.processor.js";
import { SimulatorProcessor } from "./simulator.processor.js";
import { PlanningScheduler } from "./planning.scheduler.js";
import { SchedulerService } from "./scheduler.service.js";

/**
 * The background role. Loaded only when MODE is `worker` or `all`, so an
 * API-only container never starts consuming jobs.
 */
@Module({
  providers: [
    SchedulerService,
    PlanningScheduler,
    PublishProcessor,
    AgentProcessor,
    IngestProcessor,
    SimulatorProcessor,
  ],
  exports: [PlanningScheduler],
})
export class WorkerModule {}
