import { Module } from "@nestjs/common";
import { PlanningScheduler } from "./planning.scheduler.js";

/**
 * Plan cadences, separated from the processors.
 *
 * Registering a repeatable job is a Redis write, not background work, and the
 * API has to do it the moment somebody saves a plan — otherwise the cadence is
 * decorative again. Keeping it out of WorkerModule means an `api`-only
 * container can schedule without also starting to consume jobs.
 */
@Module({
  providers: [PlanningScheduler],
  exports: [PlanningScheduler],
})
export class PlanScheduleModule {}
