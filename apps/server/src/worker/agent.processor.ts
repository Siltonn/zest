import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import { eq, schema, type Database } from "@zest/db";
import { Notifier, approvals } from "@zest/core";
import { runAnalysis, runPlanning, runReplyTriage } from "@zest/agent";
import { DATABASE } from "../infra/database.module.js";
import { REDIS_PUB } from "../infra/redis.module.js";
import { NOTIFIER } from "../infra/notifier.module.js";
import { QUEUE_AGENT_RUN } from "../queue/queue.constants.js";

/**
 * Agent runs happen here rather than in a request. They take minutes, they are
 * retryable, and their results land in the database — so the API can answer
 * immediately and the UI can follow along over SSE.
 */
@Processor(QUEUE_AGENT_RUN)
export class AgentProcessor extends WorkerHost {
  private readonly logger = new Logger(AgentProcessor.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS_PUB) private readonly redis: Redis,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    const workspaceId = job.data.workspaceId as string;

    switch (job.name) {
      case "planning": {
        const result = await runPlanning({
          db: this.db,
          workspaceId,
          publisher: this.redis,
        });
        if (result.skipped) {
          this.logger.warn(`Planning skipped: ${result.skipped}`);
          return result;
        }
        await this.notifyPending(workspaceId, "New posts are waiting for review");
        return result;
      }

      case "triage": {
        const result = await runReplyTriage({
          db: this.db,
          workspaceId,
          publisher: this.redis,
        });
        if (result.handled > 0) {
          await this.notifyPending(workspaceId, "Replies are drafted and waiting");
        }
        return result;
      }

      case "analysis":
        return runAnalysis({
          db: this.db,
          workspaceId,
          publisher: this.redis,
          weekly: Boolean(job.data.weekly),
        });

      /** Fired for every workspace on the planning cron. */
      case "plan-all": {
        const workspaces = await this.db
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces);
        for (const workspace of workspaces) {
          await runPlanning({
            db: this.db,
            workspaceId: workspace.id,
            publisher: this.redis,
          });
        }
        return { planned: workspaces.length };
      }

      default:
        this.logger.warn(`Unknown agent job ${job.name}`);
        return null;
    }
  }

  private async notifyPending(workspaceId: string, title: string): Promise<void> {
    const count = await approvals.inboxCount(this.db, workspaceId);
    if (count === 0) return;
    await this.notifier.dispatch(this.db, {
      workspaceId,
      title,
      body: `${count} item${count === 1 ? "" : "s"} in your approval inbox.`,
      url: "/inbox",
      kind: "approval",
    });
  }
}
