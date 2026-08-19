import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { Redis } from "ioredis";
import { schema, type Database } from "@zest/db";
import { Notifier, approvals, plans, recycle } from "@zest/core";
import {
  runAnalysis,
  runCopy,
  runPlanCycle,
  runReplyTriage,
  runRework,
} from "@zest/agent";
import { DATABASE } from "../infra/database.module.js";
import { REDIS_PUB } from "../infra/redis.module.js";
import { NOTIFIER } from "../infra/notifier.module.js";
import { QUEUE_AGENT_RUN } from "../queue/queue.constants.js";

/**
 * Agent runs happen here rather than in a request. They take minutes, they are
 * retryable, and their results land in the database — so the API can answer
 * immediately and the UI can follow along over SSE.
 *
 * This class is queue glue and nothing else: which job maps to which entry
 * point, and which notification its outcome deserves. The pipeline itself —
 * research feeding a strategist per plan, the write_plan gate, a copywriter
 * per account — is the `plan-cycle` workflow in @zest/agent, where it can be
 * run and inspected from Studio. What remains queued separately is what must
 * be triggerable on its own: recycling, post-approval copy, triage, analysis,
 * rework.
 */
@Processor(QUEUE_AGENT_RUN)
export class AgentProcessor extends WorkerHost {
  private readonly logger = new Logger(AgentProcessor.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS_PUB) private readonly redis: Redis,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
    @InjectQueue(QUEUE_AGENT_RUN) private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    const workspaceId = job.data.workspaceId as string;

    switch (job.name) {
      // The old per-stage names, kept for jobs already on the queue when an
      // instance upgrades. `plan-strategy` is gone entirely — a stranded one
      // logs as unknown below rather than re-running half a pipeline.
      case "planning":
      case "plan-research":
      case "plan-cycle":
        return this.planCycle(workspaceId, job.data.planId as string | undefined);
      case "plan-recycle":
        return this.planRecycle(workspaceId, job.data.planId as string);
      case "plan-copy":
        return this.planCopy(workspaceId, job.data);
      case "triage":
        return this.triage(workspaceId);
      case "analysis":
        return this.analysis(workspaceId, Boolean(job.data.weekly));
      case "rework":
        return this.rework(workspaceId, job.data.postId as string);
      case "analyze-all":
      case "report-all":
        return this.analyzeAll(job.name === "report-all");
      default:
        this.logger.warn(`Unknown agent job ${job.name}`);
        return null;
    }
  }

  /**
   * One planning cycle, whole. Enqueued with attempts: 1 on purpose — the
   * strategist and copywriter write rows, so a queue-level retry would run
   * them twice and double the plan. Failures inside the cycle are contained
   * per plan and per account by the workflow, recorded on their run rows, and
   * visible on the team page.
   */
  private async planCycle(workspaceId: string, planId?: string) {
    const active = await plans.activePlans(this.db, workspaceId);
    const targets = planId ? active.filter((p) => p.id === planId) : active;

    if (targets.length === 0) {
      this.logger.warn(`No active plans for ${workspaceId}; nothing to plan`);
      return { plans: 0 };
    }

    // Evergreen plans split off before research: their tick is a deterministic
    // pick over measured results, needs no model, and must keep working when
    // research would be skipped for lack of one.
    for (const plan of targets.filter((p) => p.kind === "evergreen")) {
      await this.queue.add("plan-recycle", { workspaceId, planId: plan.id });
    }
    if (targets.every((p) => p.kind === "evergreen")) {
      return { plans: 0, recycling: targets.length };
    }

    const result = await runPlanCycle({
      db: this.db,
      workspaceId,
      publisher: this.redis,
      planId,
    });
    if (result.skipped) {
      this.logger.warn(`Planning skipped: ${result.skipped}`);
      return result;
    }

    if (result.awaitingReview > 0) {
      await this.notifyPending(workspaceId, "A planned week is waiting for review");
    }
    if (result.proposals > 0) {
      await this.notifyPending(workspaceId, "New posts are waiting for review");
    }
    return result;
  }

  /** One evergreen tick: re-propose each account's strongest rested post. */
  private async planRecycle(workspaceId: string, planId: string) {
    const result = await recycle.recycleTick(this.db, {
      workspaceId,
      planId,
      publisher: this.redis,
    });
    if (result.skipped) {
      this.logger.log(`Recycle skipped: ${result.skipped}`);
    }
    if (result.proposed > 0) {
      await this.notifyPending(workspaceId, "Evergreen re-runs are waiting for review");
    }
    return result;
  }

  /**
   * Writing for one account, outside the cycle: this is what approving a
   * planned week enqueues, one job per account so a failure retries alone.
   */
  private async planCopy(workspaceId: string, data: Job["data"]) {
    const result = await runCopy({
      db: this.db,
      workspaceId,
      planId: data.planId as string,
      accountId: data.accountId as string,
      cycleId: data.cycleId as string | undefined,
      publisher: this.redis,
    });
    if (result.proposals > 0) {
      await this.notifyPending(workspaceId, "New posts are waiting for review");
    }
    return result;
  }

  private async triage(workspaceId: string) {
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

  private async analysis(workspaceId: string, weekly: boolean) {
    return runAnalysis({ db: this.db, workspaceId, publisher: this.redis, weekly });
  }

  /**
   * A draft sent back with a note. This is the difference between "ask for
   * changes" and "reject" — the operator says what is wrong once and the
   * revision comes back, rather than the note sitting unread.
   */
  private async rework(workspaceId: string, postId: string) {
    const result = await runRework({
      db: this.db,
      workspaceId,
      postId,
      publisher: this.redis,
    });
    if (result.skipped) {
      this.logger.warn(`Rework skipped: ${result.skipped}`);
      return result;
    }
    await this.notifyPending(workspaceId, "A revised post is waiting for review");
    return result;
  }

  /**
   * Nightly and weekly fan-out. Analysis proposes memory updates, so a quiet
   * night still ends with something in the inbox to look at in the morning —
   * which is the difference between an assistant and a tool.
   */
  private async analyzeAll(weekly: boolean) {
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
          await this.notifyPending(workspace.id, "The agent has something to propose");
        }
      } catch (error) {
        // One workspace without a model configured must not stop the rest.
        this.logger.warn(
          `${weekly ? "report-all" : "analyze-all"} failed for ${workspace.id}: ${(error as Error).message}`,
        );
      }
    }
    return { analyzed: workspaces.length, weekly };
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
