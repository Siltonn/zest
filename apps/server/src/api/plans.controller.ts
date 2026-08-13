import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { schema, type Database } from "@zest/db";
import { plans } from "@zest/core";
import { hasModelAccess } from "@zest/agent";
import { z } from "zod";
import { DATABASE } from "../infra/database.module.js";
import { QUEUE_AGENT_RUN } from "../queue/queue.constants.js";
import { WorkspaceGuard, type AuthedRequest } from "../auth/workspace.guard.js";
import { PlanningScheduler } from "../worker/planning.scheduler.js";

/**
 * Content programmes.
 *
 * A plan carries a cadence and names the accounts it writes for, so per-account
 * rhythm and cross-account campaigns are the same mechanism. Saving one has to
 * reach the queue in the same breath, or the cadence is decorative.
 */

const planInput = z.object({
  name: z.string().min(1),
  objective: z.string().optional(),
  schedule: z.string().default("weekly"),
  accountIds: z.array(z.string().uuid()).min(1),
  startsAt: z.string().datetime().nullish(),
  endsAt: z.string().datetime().nullish(),
});

/**
 * Spelled out rather than `planInput.partial()`: `.partial()` leaves the
 * `schedule` default in place, so a patch that only flips status would quietly
 * reset the cadence to weekly. Every field here is optional and defaultless.
 */
const planPatch = z.object({
  name: z.string().min(1).optional(),
  objective: z.string().nullish(),
  schedule: z.string().optional(),
  accountIds: z.array(z.string().uuid()).min(1).optional(),
  startsAt: z.string().datetime().nullish(),
  endsAt: z.string().datetime().nullish(),
  status: z.enum(["active", "paused", "archived"]).optional(),
});

@Controller("api/v1/plans")
@UseGuards(WorkspaceGuard)
export class PlansController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @InjectQueue(QUEUE_AGENT_RUN) private readonly agentQueue: Queue,
    private readonly scheduler: PlanningScheduler,
  ) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    return plans.listPlans(this.db, req.workspaceId);
  }

  // ── Plan items ────────────────────────────────────────────────────────

  @Post("items/:itemId")
  async updateItem(
    @Req() req: AuthedRequest,
    @Param("itemId") itemId: string,
    @Body() body: unknown,
  ) {
    const { suggestedSlotAt, ...rest } = z
      .object({
        topic: z.string().min(1).optional(),
        angle: z.string().nullish(),
        suggestedSlotAt: z.string().datetime().nullish(),
      })
      .parse(body);

    try {
      return await plans.updateItem(this.db, req.workspaceId, itemId, {
        ...rest,
        ...(suggestedSlotAt !== undefined
          ? { suggestedSlotAt: suggestedSlotAt ? new Date(suggestedSlotAt) : null }
          : {}),
      });
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  /**
   * Approve a planned week: release it to the writers.
   *
   * Named `approve` because that is what it is from the inbox's side — the same
   * verb as approving a post, one altitude up. Whatever survived the operator's
   * edits and skips is what gets written.
   */
  @Post(":id/approve")
  async approvePlan(@Req() req: AuthedRequest, @Param("id") id: string) {
    const found = await plans.readPlan(this.db, req.workspaceId, id);
    if (!found) throw new NotFoundException("No such plan");

    const accountIds = await plans.accountsWithPendingItems(this.db, id);
    if (accountIds.length === 0) {
      throw new BadRequestException("Nothing is waiting to be written on this plan");
    }

    for (const accountId of accountIds) {
      await this.agentQueue.add("plan-copy", {
        workspaceId: req.workspaceId,
        planId: id,
        accountId,
      });
    }

    await this.db.insert(schema.auditLogs).values({
      workspaceId: req.workspaceId,
      entityType: "plan",
      entityId: id,
      action: "approve_plan",
      actor: req.actor,
      diff: { writers: accountIds.length },
    });

    return { ok: true, writers: accountIds.length };
  }

  /** Reject the whole week — skip every unwritten item at once. */
  @Post(":id/reject")
  async rejectPlan(@Req() req: AuthedRequest, @Param("id") id: string) {
    const found = await plans.readPlan(this.db, req.workspaceId, id);
    if (!found) throw new NotFoundException("No such plan");

    const waiting = found.items.filter((i) => i.status === "planned");
    for (const item of waiting) {
      await plans.skipItem(this.db, req.workspaceId, item.id);
    }

    await this.db.insert(schema.auditLogs).values({
      workspaceId: req.workspaceId,
      entityType: "plan",
      entityId: id,
      action: "reject_plan",
      actor: req.actor,
      diff: { skipped: waiting.length },
    });

    return { ok: true, skipped: waiting.length };
  }

  /** Drop an item before anyone writes it — the cheap end of review. */
  @Post("items/:itemId/skip")
  async skipItem(@Req() req: AuthedRequest, @Param("itemId") itemId: string) {
    await plans.skipItem(this.db, req.workspaceId, itemId);
    return { ok: true };
  }

  @Get(":id")
  async read(@Req() req: AuthedRequest, @Param("id") id: string) {
    const found = await plans.readPlan(this.db, req.workspaceId, id);
    if (!found) throw new NotFoundException("No such plan");
    return found;
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = planInput.parse(body);
    const plan = await plans.createPlan(this.db, {
      workspaceId: req.workspaceId,
      name: input.name,
      objective: input.objective,
      schedule: input.schedule,
      accountIds: input.accountIds,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
    });
    await this.scheduler.sync(plan.id, req.workspaceId, plan.schedule, plan.status);
    return plan;
  }

  @Post(":id")
  async update(
    @Req() req: AuthedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { startsAt, endsAt, ...rest } = planPatch.parse(body);
    try {
      const plan = await plans.updatePlan(this.db, req.workspaceId, id, {
        ...rest,
        // Explicit null clears the window; absent leaves it alone.
        ...(startsAt !== undefined
          ? { startsAt: startsAt ? new Date(startsAt) : null }
          : {}),
        ...(endsAt !== undefined ? { endsAt: endsAt ? new Date(endsAt) : null } : {}),
      });
      // Pausing has to stop the timer, not just grey out a badge.
      await this.scheduler.sync(plan.id, req.workspaceId, plan.schedule, plan.status);
      return plan;
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    await this.scheduler.remove(id);
    await plans.deletePlan(this.db, req.workspaceId, id);
    return { ok: true };
  }

  /** Run this programme now: research first, then its strategist, then writers. */
  @Post(":id/run")
  async run(@Req() req: AuthedRequest, @Param("id") id: string) {
    if (!hasModelAccess()) {
      throw new BadRequestException(
        "No LLM provider is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY and restart to enable planning, drafting and reply triage.",
      );
    }
    const found = await plans.readPlan(this.db, req.workspaceId, id);
    if (!found) throw new NotFoundException("No such plan");
    if (found.accountIds.length === 0) {
      throw new BadRequestException("This plan has no accounts to write for");
    }

    const job = await this.agentQueue.add("plan-research", {
      workspaceId: req.workspaceId,
      planId: id,
    });
    return { queued: true, jobId: job.id };
  }

}
