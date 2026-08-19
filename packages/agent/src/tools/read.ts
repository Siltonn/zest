import { createTool } from "@mastra/core/tools";
import { and, desc, eq, schema } from "@zest/db";
import { analytics, approvals, memory } from "@zest/core";
import { listConnectorMeta } from "@zest/connectors";
import { currentTrends } from "@zest/simulator";
import { z } from "zod";
import { readToolContext } from "../context.ts";

/**
 * Read-only tools. These never pass through the autonomy guard because they
 * change nothing — the guard exists to gate side effects, not curiosity.
 */

export const getBrandBrief = createTool({
  id: "get_brand_brief",
  description:
    "Read the brand brief: who this brand is, who it talks to, what it stands for, and what it avoids.",
  inputSchema: z.object({}),
  execute: async (_input, { requestContext }) => {
    const { db, workspaceId } = readToolContext(requestContext);
    const doc = await memory.readMemory(db, workspaceId, "brand_brief");
    return {
      found: doc !== null,
      content: doc?.contentMd ?? "No brand brief has been written yet.",
      version: doc?.version ?? 0,
    };
  },
});

export const getPersona = createTool({
  id: "get_persona",
  description:
    "Read one connected account's playbook: its persona, positioning, content pillars, red lines and cadence notes. Always read this before writing for that account — each handle has its own voice and must not drift toward the others.",
  inputSchema: z.object({
    accountId: z.string().describe("The connected account to write for"),
  }),
  execute: async (input, { requestContext }) => {
    const { db, workspaceId } = readToolContext(requestContext);
    const doc = await memory.readMemory(
      db,
      workspaceId,
      "persona",
      input.accountId,
    );
    return {
      found: doc !== null,
      content: doc?.contentMd ?? "No playbook yet for this account.",
      version: doc?.version ?? 0,
    };
  },
});

export const getStrategy = createTool({
  id: "get_strategy",
  description:
    "Read the current content strategy and the learnings gathered from past performance.",
  inputSchema: z.object({}),
  execute: async (_input, { requestContext }) => {
    const { db, workspaceId } = readToolContext(requestContext);
    const [strategy, learnings] = await Promise.all([
      memory.readMemory(db, workspaceId, "strategy"),
      memory.readMemory(db, workspaceId, "learnings"),
    ]);
    return {
      strategy: strategy?.contentMd ?? "No strategy written yet.",
      learnings: learnings?.contentMd ?? "No learnings recorded yet.",
    };
  },
});

export const listAccounts = createTool({
  id: "list_accounts",
  description:
    "List the connected social accounts, with the platform each belongs to and its posting limits.",
  inputSchema: z.object({}),
  execute: async (_input, { requestContext }) => {
    const { db, workspaceId } = readToolContext(requestContext);
    const rows = await db
      .select()
      .from(schema.linkedAccounts)
      .where(eq(schema.linkedAccounts.workspaceId, workspaceId));

    const meta = new Map(listConnectorMeta().map((m) => [m.id, m]));
    return rows.map((row) => ({
      accountId: row.id,
      handle: row.handle,
      platform: row.connectorId,
      charLimit: meta.get(row.connectorId)?.charLimit ?? 280,
      features: meta.get(row.connectorId)?.features ?? [],
    }));
  },
});

export const getPlatformConstraints = createTool({
  id: "get_platform_constraints",
  description:
    "Character limits and capabilities per platform. Check this before drafting so a post is not rejected at publish time.",
  inputSchema: z.object({}),
  // Reads the same connector metadata the composer's character counter uses,
  // so the prompt and the UI can never disagree about a limit.
  execute: async () =>
    listConnectorMeta().map((m) => ({
      platform: m.id,
      name: m.name,
      charLimit: m.charLimit,
      maxImages: m.maxImages,
      features: m.features,
    })),
});

export const searchTrends = createTool({
  id: "search_trends",
  description:
    "What is gaining attention right now, with a momentum score. Use this to ground topic choices in something current.",
  inputSchema: z.object({}),
  execute: async (_input, { requestContext }) => {
    const { db } = readToolContext(requestContext);
    return currentTrends(db, 8);
  },
});

export const getAnalytics = createTool({
  id: "get_analytics",
  description:
    "Performance over a recent window: impressions, engagement rate, and the best-performing posts.",
  inputSchema: z.object({
    days: z.number().int().min(1).max(90).default(30),
  }),
  execute: async (input, { requestContext }) => {
    const { db, workspaceId } = readToolContext(requestContext);
    const [totals, best] = await Promise.all([
      analytics.summary(db, workspaceId, input.days),
      analytics.topPosts(db, workspaceId, 5),
    ]);
    return {
      totals,
      bestPosts: best.map((p) => ({
        text: p.text.slice(0, 160),
        account: p.accountHandle,
        impressions: p.impressions,
        engagementRate: Number(p.engagementRate.toFixed(4)),
      })),
    };
  },
});

export const listPosts = createTool({
  id: "list_posts",
  description:
    "Recent and upcoming posts across every account. Use this to avoid repeating a topic and to find gaps in the schedule.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).default(20),
  }),
  execute: async (input, { requestContext }) => {
    const { db, workspaceId } = readToolContext(requestContext);
    const rows = await db
      .select({ post: schema.posts, account: schema.linkedAccounts })
      .from(schema.posts)
      .innerJoin(
        schema.linkedAccounts,
        eq(schema.posts.accountId, schema.linkedAccounts.id),
      )
      .where(eq(schema.posts.workspaceId, workspaceId))
      .orderBy(desc(schema.posts.createdAt))
      .limit(input.limit);

    return rows.map(({ post, account }) => ({
      postId: post.id,
      account: account.handle,
      status: post.status,
      text: post.content.text.slice(0, 200),
      scheduledAt: post.scheduledAt?.toISOString() ?? null,
      publishedAt: post.publishedAt?.toISOString() ?? null,
    }));
  },
});

export const listPendingApprovals = createTool({
  id: "list_pending_approvals",
  description: "Everything currently waiting for a human decision.",
  inputSchema: z.object({}),
  execute: async (_input, { requestContext }) => {
    const { db, workspaceId } = readToolContext(requestContext);
    const items = await approvals.listInbox(db, workspaceId);
    return items.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      body: item.body.slice(0, 200),
      account: item.accountHandle,
      suggestedSlotAt: item.suggestedSlotAt?.toISOString() ?? null,
    }));
  },
});

export const readInboundItem = createTool({
  id: "read_inbound_item",
  description:
    "Read one incoming reply or mention in full, along with the post it responds to.",
  inputSchema: z.object({ inboundItemId: z.string() }),
  execute: async (input, { requestContext }) => {
    const { db, workspaceId } = readToolContext(requestContext);
    const [row] = await db
      .select({ inbound: schema.inboundItems, post: schema.posts })
      .from(schema.inboundItems)
      .leftJoin(schema.posts, eq(schema.inboundItems.postId, schema.posts.id))
      .where(
        and(
          eq(schema.inboundItems.id, input.inboundItemId),
          eq(schema.inboundItems.workspaceId, workspaceId),
        ),
      );

    if (!row) return { found: false };
    return {
      found: true,
      author: row.inbound.authorHandle,
      text: row.inbound.text,
      sentiment: row.inbound.sentiment,
      receivedAt: row.inbound.receivedAt.toISOString(),
      inResponseTo: row.post?.content.text ?? null,
    };
  },
});

export const READ_TOOLS = {
  get_brand_brief: getBrandBrief,
  get_persona: getPersona,
  get_strategy: getStrategy,
  list_accounts: listAccounts,
  get_platform_constraints: getPlatformConstraints,
  search_trends: searchTrends,
  get_analytics: getAnalytics,
  list_posts: listPosts,
  list_pending_approvals: listPendingApprovals,
  read_inbound_item: readInboundItem,
};
