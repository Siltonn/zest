import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import type { Queue } from "bullmq";
import { eq, schema, type Database } from "@zest/db";
import { DATABASE } from "../infra/database.module.js";
import { QUEUE_AGENT_RUN } from "../queue/queue.constants.js";

/**
 * Turns each workspace's chosen planning cadence into a real repeatable job.
 *
 * Without this the setting on the settings page is decorative — it saves, and
 * nothing changes. Each workspace gets its own scheduler keyed by id, so
 * changing the cadence replaces that workspace's schedule and leaves the others
 * alone.
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

  /** Called on boot, and again whenever a workspace changes its cadence. */
  async syncAll(): Promise<void> {
    const workspaces = await this.db
      .select({
        id: schema.workspaces.id,
        planningSchedule: schema.workspaces.planningSchedule,
      })
      .from(schema.workspaces);

    for (const workspace of workspaces) {
      await this.sync(workspace.id, workspace.planningSchedule);
    }
  }

  async sync(workspaceId: string, schedule: string): Promise<void> {
    const pattern = toCron(schedule);
    const key = `plan-${workspaceId}`;

    if (!pattern) {
      // "manual" means the operator drives it from the dashboard.
      await this.queue.removeJobScheduler(key).catch(() => undefined);
      return;
    }

    await this.queue.upsertJobScheduler(
      key,
      { pattern },
      { name: "planning", data: { workspaceId } },
    );
    this.logger.log(`planning for ${workspaceId}: ${schedule} (${pattern})`);
  }

  async remove(workspaceId: string): Promise<void> {
    await this.queue.removeJobScheduler(`plan-${workspaceId}`).catch(() => undefined);
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
