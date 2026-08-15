import { Module } from "@nestjs/common";
import { AgentProcessor } from "./agent.processor.js";
import { IngestProcessor } from "./ingest.processor.js";
import { PublishProcessor } from "./publish.processor.js";
import { SimulatorProcessor } from "./simulator.processor.js";
import { PlanScheduleModule } from "./plan-schedule.module.js";
import { SchedulerService } from "./scheduler.service.js";
import { WebhookDispatcher } from "./webhook.dispatcher.js";
import { WebhookProcessor } from "./webhook.processor.js";

/**
 * The background role. Loaded only when MODE is `worker` or `all`, so an
 * API-only container never starts consuming jobs.
 */
@Module({
  imports: [PlanScheduleModule],
  providers: [
    SchedulerService,
    PublishProcessor,
    AgentProcessor,
    IngestProcessor,
    SimulatorProcessor,
    WebhookDispatcher,
    WebhookProcessor,
  ],
})
export class WorkerModule {}
