import { createTool } from "@mastra/core/tools";
import { eq, schema } from "@zest/db";
import { autonomy, changeRequests, emit, memory, plans, transition } from "@zest/core";
import { getConnector } from "@zest/connectors";
import { z } from "zod";
import { readToolContext, type ToolContext } from "../context.ts";

/**
 * Mutating tools.
 *
 * Each one asks the autonomy guard what it may do, then either writes a
 * proposal or performs the action. This is the whole graduated-autonomy idea in
 * practice: the model sees the same tool with the same description either way,
 * and the operator's granted trust decides which branch runs. Nothing here
 * depends on the agent framework, so the behaviour survives swapping it.
 */

async function announce(
  context: ToolContext,
  summary: string,
  entityId: string,
  itemKind: "post" | "reply" | "memory" | "autonomy_request",
): Promise<void> {
  if (!context.publisher) return;
  await emit(context.publisher, {
    type: "inbox.new",
    workspaceId: context.workspaceId,
    itemKind,
    entityId,
    summary,
  });
}

export const draftPost = createTool({
  id: "draft_post",
  description:
    "Check a draft against a platform's limits before proposing it. Returns any problems; does not save anything.",
  inputSchema: z.object({
    accountId: z.string(),
    text: z.string(),
  }),
  execute: async (input, { requestContext }) => {
    const { db, workspaceId } = readToolContext(requestContext);
    const [account] = await db
      .select()
      .from(schema.linkedAccounts)
      .where(eq(schema.linkedAccounts.id, input.accountId));
    if (!account) return { ok: false, issues: ["Unknown account"] };

    const connector = getConnector(account.connectorId);
    const issues = connector.validate({ text: input.text, media: [] });
    return {
      ok: !issues.some((i) => i.severity === "error"),
      platform: connector.meta.name,
      characters: [...input.text].length,
      charLimit: connector.meta.charLimit,
      issues: issues.map((i) => `${i.severity}: ${i.message}`),
      workspaceId,
    };
  },
});

export const proposePost = createTool({
  id: "propose_post",
  description:
    "Put a post forward for a specific account, with a suggested time and a one-line reason. If autonomy has been granted for this account it is scheduled directly; otherwise it goes to the approval inbox.",
  inputSchema: z.object({
    accountId: z.string(),
    text: z.string(),
    suggestedSlotAt: z
      .string()
      .describe("ISO 8601 timestamp for when this should go out"),
    reasoning: z
      .string()
      .describe("Why this post, for this account, at this time — one or two sentences"),
    planItemId: z
      .string()
      .optional()
      .describe("The plan item this post fulfils, when writing from a plan"),
  }),
  execute: async (input, { requestContext }) => {
    const toolContext = readToolContext(requestContext);
    const { db, workspaceId, actor, runId } = toolContext;

    const [account] = await db
      .select()
      .from(schema.linkedAccounts)
      .where(eq(schema.linkedAccounts.id, input.accountId));
    if (!account) return { ok: false, error: "Unknown account" };

    const connector = getConnector(account.connectorId);
    const content = { text: input.text, media: [] };
    const issues = connector.validate(content);
    const blocking = issues.filter((i) => i.severity === "error");
    if (blocking.length > 0) {
      // Reported back to the model so it can revise rather than failing the run.
      return { ok: false, error: blocking.map((i) => i.message).join("; ") };
    }

    const slot = new Date(input.suggestedSlotAt);
    const decision = await autonomy.decide(db, {
      workspaceId,
      action: "schedule_post",
      connectorId: account.connectorId,
      accountId: account.id,
    });

    const [created] = await db
      .insert(schema.posts)
      .values({
        workspaceId,
        accountId: account.id,
        status: "draft",
        content,
        suggestedSlotAt: slot,
        reasoning: input.reasoning,
        createdByActor: actor,
        agentRunId: runId,
      })
      .returning();
    if (!created) return { ok: false, error: "Could not create the post" };

    // Closing the loop back to the plan is what lets a post answer "why does
    // this exist", and stops the copywriter writing the same item twice.
    if (input.planItemId) {
      await plans.markWritten(db, input.planItemId, created.id);
    }

    if (decision.mode === "auto") {
      await transition(db, {
        postId: created.id,
        action: "schedule",
        actor,
        agentRunId: runId,
        patch: { scheduledAt: slot },
      });
      return {
        ok: true,
        postId: created.id,
        outcome: "scheduled",
        note: `Autonomy is granted for ${account.connectorId}, so this is scheduled for ${slot.toISOString()}.`,
      };
    }

    await transition(db, {
      postId: created.id,
      action: "propose",
      actor,
      agentRunId: runId,
    });
    await announce(
      toolContext,
      `Post proposed for @${account.handle}`,
      created.id,
      "post",
    );

    return {
      ok: true,
      postId: created.id,
      outcome: "awaiting_approval",
      note: decision.downgradeReason
        ? `Sent for approval (${decision.downgradeReason}).`
        : "Sent to the approval inbox.",
    };
  },
});

export const schedulePost = createTool({
  id: "schedule_post",
  description: "Move an already-approved post into the publishing queue at a given time.",
  inputSchema: z.object({
    postId: z.string(),
    scheduledAt: z.string(),
  }),
  execute: async (input, { requestContext }) => {
    const { db, actor, runId } = readToolContext(requestContext);
    try {
      const result = await transition(db, {
        postId: input.postId,
        action: "schedule",
        actor,
        agentRunId: runId,
        patch: { scheduledAt: new Date(input.scheduledAt) },
      });
      return { ok: true, status: result.to };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  },
});

export const proposeReply = createTool({
  id: "propose_reply",
  description:
    "Draft a reply to an incoming comment or mention. Goes to the approval inbox unless auto-reply has been granted for this kind of comment.",
  inputSchema: z.object({
    inboundItemId: z.string(),
    text: z.string(),
    reasoning: z.string().describe("Why this reply, and why now"),
  }),
  execute: async (input, { requestContext }) => {
    const toolContext = readToolContext(requestContext);
    const { db, workspaceId, actor, runId } = toolContext;

    const [inbound] = await db
      .select({ item: schema.inboundItems, account: schema.linkedAccounts })
      .from(schema.inboundItems)
      .innerJoin(
        schema.linkedAccounts,
        eq(schema.inboundItems.accountId, schema.linkedAccounts.id),
      )
      .where(eq(schema.inboundItems.id, input.inboundItemId));
    if (!inbound) return { ok: false, error: "Unknown inbound item" };

    const decision = await autonomy.decide(db, {
      workspaceId,
      action: "send_reply",
      connectorId: inbound.account.connectorId,
      accountId: inbound.account.id,
      sentiment: inbound.item.sentiment ?? undefined,
    });

    const [draft] = await db
      .insert(schema.replyDrafts)
      .values({
        workspaceId,
        inboundItemId: input.inboundItemId,
        status: decision.mode === "auto" ? "approved" : "pending_approval",
        content: { text: input.text, media: [] },
        reasoning: input.reasoning,
        createdByActor: actor,
        agentRunId: runId,
      })
      .returning();
    if (!draft) return { ok: false, error: "Could not create the reply draft" };

    await db
      .update(schema.inboundItems)
      .set({ status: "triaged" })
      .where(eq(schema.inboundItems.id, input.inboundItemId));

    if (decision.mode === "auto") {
      return { ok: true, draftId: draft.id, outcome: "queued_to_send" };
    }

    await announce(
      toolContext,
      `Reply drafted for @${inbound.item.authorHandle}`,
      draft.id,
      "reply",
    );
    return {
      ok: true,
      draftId: draft.id,
      outcome: "awaiting_approval",
      note: decision.downgradeReason,
    };
  },
});

export const ignoreInbound = createTool({
  id: "ignore_inbound",
  description:
    "Recommend leaving a comment alone — bait, spam, or nothing useful to add. Records the judgement without replying.",
  inputSchema: z.object({
    inboundItemId: z.string(),
    reason: z.string(),
  }),
  execute: async (input, { requestContext }) => {
    const { db, workspaceId, actor, runId } = readToolContext(requestContext);
    await db
      .update(schema.inboundItems)
      .set({ status: "ignored" })
      .where(eq(schema.inboundItems.id, input.inboundItemId));

    await db.insert(schema.auditLogs).values({
      workspaceId,
      entityType: "inbound_item",
      entityId: input.inboundItemId,
      action: "recommend_ignore",
      actor,
      diff: { reason: input.reason },
      agentRunId: runId,
    });
    return { ok: true };
  },
});

export const updateMemory = createTool({
  id: "update_memory",
  description:
    "Rewrite one of the memory documents (strategy, learnings, brand brief, or an account's voice card). Changes to the brief or a voice card always need human approval — those define who the brand is.",
  inputSchema: z.object({
    kind: z.enum(["brand_brief", "strategy", "learnings", "persona"]),
    contentMd: z.string(),
    accountId: z
      .string()
      .optional()
      .describe("Required when kind is persona: which account's voice this is"),
    reason: z.string(),
  }),
  execute: async (input, { requestContext }) => {
    const toolContext = readToolContext(requestContext);
    const { db, workspaceId, actor, runId } = toolContext;

    if (input.kind === "persona" && !input.accountId) {
      return { ok: false, error: "A persona update must name the account it belongs to" };
    }

    const decision = await autonomy.decide(db, {
      workspaceId,
      action: "update_memory",
      accountId: input.accountId,
    });

    // Identity documents are never rewritten silently, even under autonomy:
    // an agent quietly editing who the brand is defeats the point of a brief.
    const identityDoc = input.kind === "brand_brief" || input.kind === "persona";

    if (decision.mode === "auto" && !identityDoc) {
      const doc = await memory.writeMemory(db, {
        workspaceId,
        kind: input.kind,
        contentMd: input.contentMd,
        actor,
        accountId: input.accountId,
      });
      return { ok: true, outcome: "saved", version: doc.version };
    }

    const current = await memory.readMemory(
      db,
      workspaceId,
      input.kind,
      input.accountId,
    );
    const label = input.kind.replace("_", " ");
    const proposal = await changeRequests.open(db, {
      workspaceId,
      kind: "memory",
      summary: `Proposed rewrite of ${label}`,
      rationale: input.reason,
      payload: {
        kind: input.kind,
        accountId: input.accountId ?? null,
        before: current?.contentMd ?? null,
        after: input.contentMd,
      },
      agentRunId: runId,
    });

    await announce(
      toolContext,
      `Proposed an update to ${label}`,
      proposal.id,
      "memory",
    );
    return {
      ok: true,
      outcome: "awaiting_approval",
      note: identityDoc
        ? "Identity documents always go through review."
        : "Sent to the approval inbox.",
    };
  },
});

export const requestAutonomy = createTool({
  id: "request_autonomy",
  description:
    "Ask for permission to perform an action without review from now on. Only worth doing when a run of proposals has been approved unchanged.",
  inputSchema: z.object({
    action: z.enum(["schedule_post", "send_reply", "update_memory"]),
    connectorId: z.string().optional(),
    rationale: z.string(),
  }),
  execute: async (input, { requestContext }) => {
    const toolContext = readToolContext(requestContext);
    const { db, workspaceId, actor, runId } = toolContext;

    const stats = await autonomy.trustStats(db, workspaceId, input.action);
    if (!stats.readyToGraduate) {
      return {
        ok: false,
        note: `Not yet — ${stats.consecutiveCleanApprovals} approvals in a row without edits. Keep going.`,
      };
    }

    const label = input.action.replace(/_/g, " ");
    const request = await changeRequests.open(db, {
      workspaceId,
      kind: "autonomy",
      summary: `Asking to ${label} without review`,
      rationale: `${input.rationale} (${stats.consecutiveCleanApprovals} proposals approved unchanged in a row.)`,
      payload: {
        action: input.action,
        connectorId: input.connectorId ?? null,
        accountId: null,
        consecutiveCleanApprovals: stats.consecutiveCleanApprovals,
      },
      agentRunId: runId,
    });

    await announce(
      toolContext,
      `Requested autonomy for ${label}`,
      request.id,
      "autonomy_request",
    );
    return { ok: true, outcome: "awaiting_approval" };
  },
});


/**
 * The strategist's output, as rows rather than prose.
 *
 * This is the seam between planning and writing. Making it a tool call instead
 * of a paragraph the next role has to parse means the plan can be read, edited
 * and retried on its own — and each item carries the account it belongs to, so
 * the copywriter can be run once per voice instead of juggling all of them in
 * one context.
 */
export const addPlanItems = createTool({
  id: "add_plan_items",
  description:
    "Record the posts this plan should produce. One entry per post: which account, the topic, the angle for that account specifically, and when it should go out. Call this once with the whole plan.",
  inputSchema: z.object({
    items: z
      .array(
        z.object({
          accountId: z.string(),
          topic: z.string().describe("What the post is about, in a few words"),
          angle: z
            .string()
            .describe(
              "How this account in particular should treat it — what makes it not the other account's version",
            ),
          suggestedSlotAt: z
            .string()
            .describe("ISO 8601 timestamp for when it should go out"),
        }),
      )
      .min(1),
  }),
  execute: async (input, { requestContext }) => {
    const { db, workspaceId, planId, runId } = readToolContext(requestContext);
    if (!planId) {
      return { ok: false, error: "This run is not attached to a plan" };
    }

    // Accounts are checked against the plan's own targets: a strategist that
    // wanders onto an account this programme does not cover would produce
    // items the copywriter fan-out never picks up.
    const targets = await db
      .select({ accountId: schema.planAccounts.accountId })
      .from(schema.planAccounts)
      .where(eq(schema.planAccounts.planId, planId));
    const allowed = new Set(targets.map((t) => t.accountId));

    const rejected = input.items.filter((i) => !allowed.has(i.accountId));
    const accepted = input.items.filter((i) => allowed.has(i.accountId));
    if (accepted.length === 0) {
      return {
        ok: false,
        error: `None of those accounts are on this plan. It covers: ${[...allowed].join(", ")}`,
      };
    }

    const created = await plans.addItems(db, {
      planId,
      workspaceId,
      agentRunId: runId,
      items: accepted.map((item) => ({
        accountId: item.accountId,
        topic: item.topic,
        angle: item.angle,
        suggestedSlotAt: new Date(item.suggestedSlotAt),
      })),
    });

    return {
      ok: true,
      added: created.length,
      ...(rejected.length > 0
        ? { skipped: `${rejected.length} item(s) named an account not on this plan` }
        : {}),
    };
  },
});

/**
 * The weekly report, submitted rather than scraped.
 *
 * It used to be saved from the run's concatenated text, which meant the
 * operator's report opened with "I'll review the recent performance and posts…
 * Let me start by gathering the analytics" — the model's narration between tool
 * calls, stored as the document. Same lesson as `add_plan_items`: take what the
 * model explicitly submits, do not parse what it happened to say.
 *
 * Not routed through `update_memory` on purpose. A report is a record of what
 * happened, not a change to policy, so it saves directly instead of waiting for
 * someone to approve last week's numbers.
 */
export const writeReport = createTool({
  id: "write_report",
  description:
    "File the weekly report. Pass the finished report only — no preamble, no narration about what you are about to do. Markdown, with what went out, how it did, what you learned, and what you plan next.",
  inputSchema: z.object({
    contentMd: z.string().min(1),
  }),
  execute: async (input, { requestContext }) => {
    const { db, workspaceId, actor, runId } = readToolContext(requestContext);
    const doc = await memory.writeMemory(db, {
      workspaceId,
      kind: "report",
      contentMd: input.contentMd,
      actor,
    });
    return { ok: true, version: doc.version, runId };
  },
});

export const WRITE_TOOLS = {
  add_plan_items: addPlanItems,
  draft_post: draftPost,
  propose_post: proposePost,
  schedule_post: schedulePost,
  propose_reply: proposeReply,
  ignore_inbound: ignoreInbound,
  update_memory: updateMemory,
  write_report: writeReport,
  request_autonomy: requestAutonomy,
};
