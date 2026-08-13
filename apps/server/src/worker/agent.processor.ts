import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { Redis } from "ioredis";
import { eq, schema, type Database } from "@zest/db";
import { Notifier, approvals, autonomy, emit, plans } from "@zest/core";
import { runAnalysis, runCopy, runReplyTriage, runResearch, runStrategy } from "@zest/agent";
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
    // Stages enqueue the next stage rather than calling it, so each one retries
    // on its own and shows up as a separate entry on the queue board.
    @InjectQueue(QUEUE_AGENT_RUN) private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    const workspaceId = job.data.workspaceId as string;

    switch (job.name) {
      /**
       * Stage one of a planning cycle, and the only one that runs per
       * workspace. It fans out to a strategy job per active plan rather than
       * calling them inline, so a plan that fails does not take the others with
       * it and can be retried on its own from the queue.
       */
      case "planning":
      case "plan-research": {
        const result = await runResearch({
          db: this.db,
          workspaceId,
          publisher: this.redis,
        });
        if (result.skipped) {
          this.logger.warn(`Research skipped: ${result.skipped}`);
          return result;
        }

        const only = job.data.planId as string | undefined;
        const active = await plans.activePlans(this.db, workspaceId);
        const targets = only ? active.filter((p) => p.id === only) : active;

        if (targets.length === 0) {
          this.logger.warn(`No active plans for ${workspaceId}; nothing to plan`);
          return { ...result, plans: 0 };
        }

        for (const plan of targets) {
          await this.queue.add("plan-strategy", {
            workspaceId,
            planId: plan.id,
            briefing: result.briefing,
            cycleId: result.runId,
          });
        }
        return { ...result, plans: targets.length };
      }

      /** Stage two: one programme's plan, fanning out to a writer per account. */
      case "plan-strategy": {
        const result = await runStrategy({
          db: this.db,
          workspaceId,
          planId: job.data.planId as string,
          briefing: (job.data.briefing as string) ?? "",
          cycleId: job.data.cycleId as string | undefined,
          publisher: this.redis,
        });
        if (result.skipped) {
          this.logger.warn(`Strategy skipped: ${result.skipped}`);
          return result;
        }

        const planId = job.data.planId as string;
        const accountIds = await plans.accountsWithPendingItems(this.db, planId);

        // The cheap review altitude. Without a granted rule the planned week
        // waits in the inbox as one card, so topics can be dropped before a
        // model call turns each into a draft. With `auto` it goes straight to
        // the writers — same stage, same code, different trust.
        const decision = await autonomy.decide(this.db, {
          workspaceId,
          action: "write_plan",
        });

        if (decision.mode !== "auto") {
          await emit(this.redis, {
            type: "inbox.new",
            workspaceId,
            itemKind: "plan",
            entityId: planId,
            summary: `A week of content is planned and waiting for review`,
          });
          await this.notifyPending(workspaceId, "A planned week is waiting for review");
          return { ...result, awaitingReview: accountIds.length };
        }

        for (const accountId of accountIds) {
          await this.queue.add("plan-copy", {
            workspaceId,
            planId,
            accountId,
            cycleId: job.data.cycleId,
          });
        }
        return { ...result, writers: accountIds.length };
      }

      /** Stage three: one account's voice, in its own context. */
      case "plan-copy": {
        const result = await runCopy({
          db: this.db,
          workspaceId,
          planId: job.data.planId as string,
          accountId: job.data.accountId as string,
          cycleId: job.data.cycleId as string | undefined,
          publisher: this.redis,
        });
        if (result.proposals > 0) {
          await this.notifyPending(workspaceId, "New posts are waiting for review");
        }
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
          await this.queue.add("plan-research", { workspaceId: workspace.id });
        }
        return { planned: workspaces.length };
      }

      /**
       * Nightly and weekly fan-out. Analysis proposes memory updates, so a
       * quiet night still ends with something in the inbox to look at in the
       * morning — which is the difference between an assistant and a tool.
       */
      case "analyze-all":
      case "report-all": {
        const weekly = job.name === "report-all";
        const workspaces = await this.db
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces);
        for (const workspace of workspaces) {
          try {
            await runAnalysis({
              db: this.db,
              workspaceId: workspace.id,
              publisher: this.redis,
              weekly,
            });
            if (weekly) {
              await this.notifier.dispatch(this.db, {
                workspaceId: workspace.id,
                title: "Your weekly report is ready",
                body: "Last week's numbers, what the agent learned, and its plan for this week.",
                url: "/dashboard",
                kind: "report",
              });
            } else {
              await this.notifyPending(
                workspace.id,
                "The agent has something to propose",
              );
            }
          } catch (error) {
            // One workspace without a model configured must not stop the rest.
            this.logger.warn(
              `${job.name} failed for ${workspace.id}: ${(error as Error).message}`,
            );
          }
        }
        return { analyzed: workspaces.length, weekly };
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
