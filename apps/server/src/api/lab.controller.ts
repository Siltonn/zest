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
import { and, eq, schema, type Database } from "@zest/db";
import { automations, transition } from "@zest/core";
import { runWindTunnel } from "@zest/simulator";
import { getConnector } from "@zest/connectors";
import { z } from "zod";
import { DATABASE } from "../infra/database.module.js";
import { WorkspaceGuard, type AuthedRequest } from "../auth/workspace.guard.js";

/**
 * The two features that only exist because Zest ships its own network:
 * pre-publish variant testing, and rule-based engagement that fires against a
 * platform we control.
 */
@Controller("api/v1")
@UseGuards(WorkspaceGuard)
export class LabController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Post("wind-tunnel")
  async windTunnel(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = z
      .object({
        accountId: z.string().uuid(),
        variants: z
          .array(z.object({ id: z.string(), text: z.string().min(1) }))
          .min(2)
          .max(4),
      })
      .parse(body);

    try {
      return await runWindTunnel(this.db, input);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  /**
   * Send the winning variant on as a real proposal.
   *
   * Without this the wind tunnel is a toy: it scores copy against a simulated
   * audience and then leaves you to retype the winner by hand. Promoting goes
   * through the same approval path as anything else — a rehearsal is evidence,
   * not permission.
   */
  @Post("wind-tunnel/promote")
  async promote(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = z
      .object({
        accountId: z.string().uuid(),
        text: z.string().min(1),
        score: z.number().optional(),
        runnerUpScore: z.number().optional(),
        suggestedSlotAt: z.string().datetime().optional(),
      })
      .parse(body);

    const [account] = await this.db
      .select()
      .from(schema.linkedAccounts)
      .where(
        and(
          eq(schema.linkedAccounts.id, input.accountId),
          eq(schema.linkedAccounts.workspaceId, req.workspaceId),
        ),
      );
    if (!account) throw new NotFoundException("Account not found");

    const content = { text: input.text, media: [] };
    const issues = getConnector(account.connectorId)
      .validate(content)
      .filter((i) => i.severity === "error");
    if (issues.length > 0) {
      throw new BadRequestException(issues.map((i) => i.message).join("; "));
    }

    const margin =
      input.score !== undefined && input.runnerUpScore !== undefined
        ? ` (${input.score.toFixed(2)} vs ${input.runnerUpScore.toFixed(2)} for the runner-up)`
        : "";

    const [created] = await this.db
      .insert(schema.posts)
      .values({
        workspaceId: req.workspaceId,
        accountId: account.id,
        status: "draft",
        content,
        suggestedSlotAt: input.suggestedSlotAt
          ? new Date(input.suggestedSlotAt)
          : null,
        reasoning: `Won a wind tunnel run against the simulated audience${margin}.`,
        createdByActor: req.actor,
      })
      .returning();
    if (!created) throw new BadRequestException("Could not create the post");

    await transition(this.db, {
      postId: created.id,
      action: "propose",
      actor: req.actor,
    });

    return { ok: true, postId: created.id };
  }

  @Get("automations")
  async list(@Req() req: AuthedRequest) {
    return automations.listAutomations(this.db, req.workspaceId);
  }

  @Post("automations")
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = z
      .object({
        kind: z.enum(["auto_plug", "auto_reply", "auto_dm"]),
        accountId: z.string().uuid().optional(),
        trigger: z.object({
          threshold: z.number().int().positive().optional(),
          sentiment: z.enum(["positive", "neutral", "negative"]).optional(),
          keywords: z.array(z.string()).optional(),
        }),
        template: z.string().optional(),
      })
      .parse(body);

    return automations.createAutomation(this.db, {
      workspaceId: req.workspaceId,
      ...input,
    });
  }

  @Delete("automations/:id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    await automations.deleteAutomation(this.db, req.workspaceId, id);
    return { ok: true };
  }

  /** Shows what would fire right now, without firing it. */
  @Get("automations/preview")
  async preview(@Req() req: AuthedRequest) {
    return automations.evaluate(this.db, req.workspaceId);
  }
}
