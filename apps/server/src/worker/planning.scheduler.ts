import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import type { Queue } from "bullmq";
import { eq, schema, type Database } from "@zest/db";
import { DATABASE } from "../infra/database.module.js";
import { QUEUE_AGENT_RUN } from "../queue/queue.constants.js";

/**
 * Turns each plan's cadence into a real repeatable job.
 *
 * The cadence used to live on the workspace, which meant every account moved at
 * the same speed. It now lives on the plan, so a founder programme can fire
 * daily beside a brand programme firing weekly — and a launch week can run
 * hourly for seven days and then stop, because a plan carries its own window.
 *
 * Keyed by plan id: changing one programme's cadence replaces its schedule and
 * leaves the others alone.
 */
@Injectable()
export class PlanningScheduler implements OnModuleInit {
  private readonly logger = new Logger(PlanningScheduler.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @InjectQueue(QUEUE_AGENT_RUN) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.syncAll();
  }

  /** Called on boot, and again whenever a plan's cadence or status changes. */
  async syncAll(): Promise<void> {
    const rows = await this.db
      .select({
        id: schema.plans.id,
        workspaceId: schema.plans.workspaceId,
        schedule: schema.plans.schedule,
        status: schema.plans.status,
      })
      .from(schema.plans);

    for (const plan of rows) {
      await this.sync(plan.id, plan.workspaceId, plan.schedule, plan.status);
    }

    await this.pruneOrphans(new Set(rows.map((p) => p.id)));
  }

  /**
   * Drop timers with nothing behind them.
   *
   * Two ways they appear: a plan deleted while this process was down, and the
   * upgrade from workspace-level cadence, which left a `plan-<workspaceId>`
   * scheduler that would happily keep firing alongside the new per-plan ones —
   * planning twice a day for anyone who upgraded rather than installed fresh.
   */
  private async pruneOrphans(live: Set<string>): Promise<void> {
    const scheduled = await this.queue.getJobSchedulers(0, -1);
    for (const entry of scheduled) {
      const key = entry?.key;
      if (!key?.startsWith("plan-")) continue;
      const id = key.slice("plan-".length);
      if (live.has(id)) continue;

      await this.queue.removeJobScheduler(key).catch(() => undefined);
      this.logger.log(`removed stale schedule ${key}`);
    }
  }

  async sync(
    planId: string,
    workspaceId: string,
    schedule: string,
    status: string,
  ): Promise<void> {
    const pattern = status === "active" ? toCron(schedule) : null;
    const key = `plan-${planId}`;

    if (!pattern) {
      // Paused, archived, or "manual" — the operator drives it by hand.
      await this.queue.removeJobScheduler(key).catch(() => undefined);
      return;
    }

    await this.queue.upsertJobScheduler(
      key,
      { pattern },
      {
        name: "plan-cycle",
        data: { workspaceId, planId },
        // Never retried whole: the strategist and copywriter write rows, so a
        // second pass doubles the plan. Failures are contained per stage
        // inside the workflow and recorded on their run rows.
        opts: { attempts: 1 },
      },
    );
    this.logger.log(`plan ${planId}: ${schedule} (${pattern})`);
  }

  async remove(planId: string): Promise<void> {
    await this.queue.removeJobScheduler(`plan-${planId}`).catch(() => undefined);
  }
}

/**
 * Named cadences map to cron; anything else is passed through as a raw
 * expression, so a self-hoster who wants "twice a week at 07:30" can say so.
 * Planning runs early enough that proposals are waiting at the start of the day.
 */
export function toCron(schedule: string): string | null {
  switch (schedule) {
    case "manual":
      return null;
    case "daily":
      return "0 7 * * *";
    case "weekdays":
      return "0 7 * * 1-5";
    case "weekly":
      return "0 7 * * 1";
    default:
      // Five or six fields looks like cron; anything else is a typo we should
      // not silently turn into a schedule.
      return /^[\d*,/\-\s?]{5,}$/.test(schedule.trim()) ? schedule.trim() : null;
  }
}
