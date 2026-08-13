import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Database } from "@zest/db";
import { automations } from "@zest/core";
import { runWindTunnel } from "@zest/simulator";
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
