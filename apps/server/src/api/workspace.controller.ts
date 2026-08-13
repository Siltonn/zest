import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, schema, type Database } from "@zest/db";
import { analytics, audit, autonomy, memory, onboarding } from "@zest/core";
import { getConnector, listConnectorMeta } from "@zest/connectors";
import { getTokenVault } from "@zest/shared";
import {
  advanceClock,
  ONE_SIM_DAY,
  readClock,
  releaseDueEvents,
} from "@zest/simulator";
import { hasModelAccess } from "@zest/agent";
import type { Redis } from "ioredis";
import { z } from "zod";
import { DATABASE } from "../infra/database.module.js";
import { REDIS_PUB } from "../infra/redis.module.js";
import {
  QUEUE_AGENT_RUN,
  QUEUE_INGEST,
  QUEUE_SIMULATOR,
} from "../queue/queue.constants.js";
import { WorkspaceGuard, type AuthedRequest } from "../auth/workspace.guard.js";
import { toCron } from "../worker/planning.scheduler.js";

/** Workspace settings, accounts, memory, autonomy, analytics and audit. */
@Controller("api/v1")
@UseGuards(WorkspaceGuard)
export class WorkspaceController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @InjectQueue(QUEUE_AGENT_RUN) private readonly agentQueue: Queue,
    @InjectQueue(QUEUE_SIMULATOR) private readonly simulatorQueue: Queue,
    @InjectQueue(QUEUE_INGEST) private readonly ingestQueue: Queue,
    @Inject(REDIS_PUB) private readonly redis: Redis,
  ) {}

  /**
   * Who the request resolved to. Better Auth's own session endpoint is not
   * enough: demo mode signs in through the guard rather than a cookie, and an
   * API key has no user at all. This reports what actually happened.
   */
  @Get("me")
  async me(@Req() req: AuthedRequest) {
    const [workspace] = await this.db
      .select({ id: schema.workspaces.id, name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, req.workspaceId));

    if (!req.userId) {
      // An API or MCP client — real, but not a person.
      return { user: null, actor: req.actor, workspace };
    }

    const [user] = await this.db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        image: schema.users.image,
      })
      .from(schema.users)
      .where(eq(schema.users.id, req.userId));

    return {
      user: user ?? null,
      actor: req.actor,
      workspace,
      // Lets the UI disable what cannot work and say why, rather than
      // presenting a button that quietly does nothing.
      capabilities: { llm: hasModelAccess() },
    };
  }

  @Get("workspace")
  async workspace(@Req() req: AuthedRequest) {
    const [workspace] = await this.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, req.workspaceId));
    const clock = await readClock(this.db, req.workspaceId);
    return { ...workspace, simNow: clock.simNow };
  }

  @Post("workspace")
  async updateWorkspace(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = z
      .object({
        name: z.string().optional(),
        timezone: z.string().optional(),
        planningSchedule: z.string().optional(),
        kpiConfig: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(body);

    const [updated] = await this.db
      .update(schema.workspaces)
      .set(input as never)
      .where(eq(schema.workspaces.id, req.workspaceId))
      .returning();

    // Changing the cadence has to reach the queue, or the setting saves and
    // nothing actually happens differently.
    if (input.planningSchedule) {
      await this.agentQueue.upsertJobScheduler(
        `plan-${req.workspaceId}`,
        { pattern: toCron(input.planningSchedule) ?? "0 7 * * *" },
        { name: "planning", data: { workspaceId: req.workspaceId } },
      );
    }

    return updated;
  }

  // ── Connected accounts ────────────────────────────────────────────────

  @Get("accounts")
  async accounts(@Req() req: AuthedRequest) {
    const rows = await this.db
      .select()
      .from(schema.linkedAccounts)
      .where(eq(schema.linkedAccounts.workspaceId, req.workspaceId));

    const meta = new Map(listConnectorMeta().map((m) => [m.id, m]));
    // Tokens are never serialized out of the API, encrypted or otherwise.
    return rows.map(({ accessTokenEnc, refreshTokenEnc, ...account }) => ({
      ...account,
      platform: meta.get(account.connectorId) ?? null,
    }));
  }

  @Post("accounts")
  async connectAccount(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = z
      .object({
        connectorId: z.string(),
        fields: z.record(z.string(), z.string()),
      })
      .parse(body);

    const connector = getConnector(input.connectorId);
    if (!connector.connectWithFields) {
      throw new BadRequestException(
        `${connector.meta.name} connects through OAuth, not credentials`,
      );
    }

    const { credentials, profile } = await connector.connectWithFields(input.fields);
    const vault = getTokenVault();

    const [account] = await this.db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId: req.workspaceId,
        connectorId: input.connectorId,
        handle: profile.handle,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl ?? null,
        profileUrl: profile.profileUrl ?? null,
        externalId: credentials.externalId ?? profile.externalId,
        endpoint: credentials.endpoint ?? null,
        accessTokenEnc: credentials.accessToken
          ? vault.encrypt(credentials.accessToken)
          : null,
        refreshTokenEnc: credentials.refreshToken
          ? vault.encrypt(credentials.refreshToken)
          : null,
      })
      .returning();
    if (!account) throw new BadRequestException("Could not save the account");

    // A connected account with no voice card makes the agent write in nobody's
    // voice. Seeding a starter one means the first planning run has something
    // to work from, and gives the operator something concrete to edit rather
    // than a blank page.
    await memory.writeMemory(this.db, {
      workspaceId: req.workspaceId,
      kind: "persona",
      accountId: account.id,
      contentMd: onboarding.starterPersona({
        handle: profile.handle,
        displayName: profile.displayName ?? profile.handle,
        platform: connector.meta.name,
      }),
      actor: { kind: "system", source: "connect-account" },
    });

    return { id: account.id, handle: profile.handle };
  }

  /**
   * What this workspace still has to do before the loop closes. Computed from
   * real state rather than a dismissed flag, so it stays honest.
   */
  @Get("onboarding")
  async onboardingState(@Req() req: AuthedRequest) {
    return onboarding.readOnboarding(this.db, req.workspaceId);
  }

  @Delete("accounts/:id")
  async disconnect(@Req() req: AuthedRequest, @Param("id") id: string) {
    await this.db
      .delete(schema.linkedAccounts)
      .where(
        and(
          eq(schema.linkedAccounts.id, id),
          eq(schema.linkedAccounts.workspaceId, req.workspaceId),
        ),
      );
    return { ok: true };
  }

  // ── Memory ────────────────────────────────────────────────────────────

  @Get("memory")
  async memoryDocs(@Req() req: AuthedRequest, @Query("accountId") accountId?: string) {
    const [brief, strategy, learnings, report] = await Promise.all([
      memory.readMemory(this.db, req.workspaceId, "brand_brief"),
      memory.readMemory(this.db, req.workspaceId, "strategy"),
      memory.readMemory(this.db, req.workspaceId, "learnings"),
      memory.readMemory(this.db, req.workspaceId, "report"),
    ]);
    const persona = accountId
      ? await memory.readMemory(this.db, req.workspaceId, "persona", accountId)
      : null;
    return { brief, strategy, learnings, persona, report };
  }

  @Get("memory/:kind/history")
  async memoryHistory(
    @Req() req: AuthedRequest,
    @Param("kind") kind: string,
    @Query("accountId") accountId?: string,
  ) {
    return memory.memoryHistory(
      this.db,
      req.workspaceId,
      kind as never,
      accountId,
    );
  }

  @Post("memory")
  async writeMemory(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = z
      .object({
        kind: z.enum(["brand_brief", "strategy", "learnings", "persona", "report"]),
        contentMd: z.string(),
        accountId: z.string().uuid().optional(),
      })
      .parse(body);

    return memory.writeMemory(this.db, {
      workspaceId: req.workspaceId,
      kind: input.kind,
      contentMd: input.contentMd,
      actor: req.actor,
      accountId: input.accountId,
    });
  }

  // ── Autonomy ──────────────────────────────────────────────────────────

  @Get("autonomy")
  async autonomyRules(@Req() req: AuthedRequest) {
    const rules = await this.db
      .select()
      .from(schema.autonomyRules)
      .where(eq(schema.autonomyRules.workspaceId, req.workspaceId));

    // Trust stats drive the "ready to graduate" prompt in the UI.
    const actions = ["schedule_post", "send_reply", "update_memory"] as const;
    const trust = await Promise.all(
      actions.map((action) => autonomy.trustStats(this.db, req.workspaceId, action)),
    );
    return { rules, trust };
  }

  @Post("autonomy")
  async grant(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = z
      .object({
        action: z.enum([
          "propose_post",
          "schedule_post",
          "send_reply",
          "update_memory",
          "engagement_automation",
        ]),
        mode: z.enum(["approve", "auto"]),
        connectorId: z.string().optional(),
        accountId: z.string().uuid().optional(),
        conditions: z
          .object({
            sentiment: z.enum(["positive", "neutral", "negative"]).optional(),
            maxPerDay: z.number().int().positive().optional(),
          })
          .optional(),
      })
      .parse(body);

    return autonomy.grantAutonomy(this.db, {
      workspaceId: req.workspaceId,
      grantedBy: req.userId ?? "api",
      ...input,
    });
  }

  @Delete("autonomy/:id")
  async revoke(@Req() req: AuthedRequest, @Param("id") id: string) {
    await autonomy.revokeAutonomy(
      this.db,
      req.workspaceId,
      id,
      req.userId ?? "api",
    );
    return { ok: true };
  }

  // ── Analytics ─────────────────────────────────────────────────────────

  @Get("analytics")
  async analytics(@Req() req: AuthedRequest, @Query("days") days = "30") {
    const window = Number(days) || 30;
    const [summary, top, impressions, followers] = await Promise.all([
      analytics.summary(this.db, req.workspaceId, window),
      analytics.topPosts(this.db, req.workspaceId, 5),
      analytics.timeseries(this.db, req.workspaceId, "impressions", window),
      analytics.timeseries(this.db, req.workspaceId, "followers", window),
    ]);
    return { summary, topPosts: top, series: { impressions, followers } };
  }

  // ── Audit ─────────────────────────────────────────────────────────────

  @Get("audit")
  async auditLog(
    @Req() req: AuthedRequest,
    @Query("entityType") entityType?: string,
    @Query("actorKind") actorKind?: string,
  ) {
    const [entries, breakdown] = await Promise.all([
      audit.listAudit(this.db, req.workspaceId, {
        entityType,
        actorKind: actorKind as never,
        limit: 200,
      }),
      audit.actorBreakdown(this.db, req.workspaceId),
    ]);
    return { entries, breakdown };
  }

  @Get("runs")
  async runs(@Req() req: AuthedRequest) {
    return this.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.workspaceId, req.workspaceId))
      .orderBy(desc(schema.agentRuns.startedAt))
      .limit(50);
  }

  @Get("runs/:id")
  async run(@Req() req: AuthedRequest, @Param("id") id: string) {
    const [run] = await this.db
      .select()
      .from(schema.agentRuns)
      .where(
        and(
          eq(schema.agentRuns.id, id),
          eq(schema.agentRuns.workspaceId, req.workspaceId),
        ),
      );
    return run ?? null;
  }

  // ── Agent triggers ────────────────────────────────────────────────────

  @Post("agent/plan")
  async plan(@Req() req: AuthedRequest) {
    // Queueing work the worker will silently skip is worse than saying no.
    this.requireModel();
    const job = await this.agentQueue.add("planning", {
      workspaceId: req.workspaceId,
    });
    return { queued: true, jobId: job.id };
  }

  /** The thinking steps need a provider; the platform loop does not. */
  private requireModel(): void {
    if (!hasModelAccess()) {
      throw new BadRequestException(
        "No LLM provider is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY and restart to enable planning, drafting and reply triage.",
      );
    }
  }

  @Post("agent/analyze")
  async analyze(@Req() req: AuthedRequest, @Body() body: { weekly?: boolean }) {
    this.requireModel();
    const job = await this.agentQueue.add("analysis", {
      workspaceId: req.workspaceId,
      weekly: body?.weekly ?? false,
    });
    return { queued: true, jobId: job.id };
  }

  @Post("agent/triage")
  async triage(@Req() req: AuthedRequest) {
    this.requireModel();
    const job = await this.agentQueue.add("triage", {
      workspaceId: req.workspaceId,
    });
    return { queued: true, jobId: job.id };
  }

  /**
   * Pull engagement now rather than waiting for the polling cron. Useful after
   * a fast-forward, and for anyone who just wants their numbers refreshed.
   */
  @Post("ingest/poll")
  async pollNow(@Req() req: AuthedRequest) {
    const job = await this.ingestQueue.add("poll-engagement", {
      workspaceId: req.workspaceId,
    });
    return { queued: true, jobId: job.id };
  }

  // ── Simulated clock ───────────────────────────────────────────────────

  /**
   * Fast-forward. Advances Pomelo's clock so a day of engagement plays out at
   * once — the moment that makes the whole loop visible in a demo.
   */
  @Post("simulator/fast-forward")
  async fastForward(@Req() req: AuthedRequest, @Body() body: { days?: number }) {
    const days = Math.min(Math.max(body?.days ?? 1, 1), 7);
    const clock = await advanceClock(this.db, req.workspaceId, days * ONE_SIM_DAY);

    // Released inline so the response can say what actually happened. Waiting
    // on the queue would mean answering "done" before anything had occurred.
    const released = await releaseDueEvents(this.db, req.workspaceId, { limit: 500 });
    await this.ingestQueue.add("poll-engagement", { workspaceId: req.workspaceId });

    const replies = released.filter((e) => e.kind === "reply").length;
    return {
      simNow: clock.simNow,
      released: released.length,
      replies,
    };
  }

  // ── Notification targets ──────────────────────────────────────────────

  @Get("notifications")
  async notifications(@Req() req: AuthedRequest) {
    return this.db
      .select()
      .from(schema.notificationTargets)
      .where(eq(schema.notificationTargets.workspaceId, req.workspaceId));
  }

  @Post("notifications")
  async addNotification(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = z
      .object({
        kind: z.enum(["email", "slack", "discord"]),
        config: z.object({
          email: z.string().email().optional(),
          webhookUrl: z.string().url().optional(),
        }),
        digestMode: z.enum(["instant", "daily"]).default("instant"),
        quietHours: z
          .object({ start: z.number().min(0).max(23), end: z.number().min(0).max(23) })
          .optional(),
      })
      .parse(body);

    const [created] = await this.db
      .insert(schema.notificationTargets)
      .values({ workspaceId: req.workspaceId, ...input })
      .returning();
    return created;
  }

  @Delete("notifications/:id")
  async removeNotification(@Req() req: AuthedRequest, @Param("id") id: string) {
    await this.db
      .delete(schema.notificationTargets)
      .where(
        and(
          eq(schema.notificationTargets.id, id),
          eq(schema.notificationTargets.workspaceId, req.workspaceId),
        ),
      );
    return { ok: true };
  }

  // ── API keys (how external agents authenticate) ───────────────────────

  @Get("api-keys")
  async listKeys(@Req() req: AuthedRequest) {
    const rows = await this.db
      .select({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        createdAt: schema.apiKeys.createdAt,
      })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.workspaceId, req.workspaceId));
    return rows;
  }

  @Post("api-keys")
  async createKey(@Req() req: AuthedRequest, @Body() body: { name?: string }) {
    const secret = `zest_${randomBytes(24).toString("base64url")}`;
    const [created] = await this.db
      .insert(schema.apiKeys)
      .values({
        workspaceId: req.workspaceId,
        name: body?.name ?? "API key",
        hashedKey: createHash("sha256").update(secret).digest("hex"),
        scopes: ["read", "write"],
      })
      .returning({ id: schema.apiKeys.id, name: schema.apiKeys.name });

    // Returned exactly once — only the hash is stored.
    return { ...created, key: secret };
  }

  @Delete("api-keys/:id")
  async deleteKey(@Req() req: AuthedRequest, @Param("id") id: string) {
    await this.db
      .delete(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.id, id),
          eq(schema.apiKeys.workspaceId, req.workspaceId),
        ),
      );
    return { ok: true };
  }
}
