import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, desc, eq, schema, type Database } from "@zest/db";
import { analytics, approvals, audit, memory } from "@zest/core";
import type { Actor } from "@zest/shared";
import { z } from "zod";

/**
 * The MCP surface.
 *
 * Zest is an agent, and it is also something other agents can drive: Claude
 * Desktop connects to a deployed instance and reviews the queue, approves work,
 * or asks how the week went. These tools call the same `@zest/core` services the
 * REST API and the queue processors use, so an approval over MCP is
 * indistinguishable from one clicked in the web UI — except in the audit log,
 * which records exactly which client did it.
 */

export type McpContext = {
  db: Database;
  workspaceId: string;
  actor: Actor;
};

export function createZestMcpServer(context: McpContext): McpServer {
  const server = new McpServer({
    name: "zest",
    version: "0.1.0",
  });

  const { db, workspaceId, actor } = context;

  server.registerTool(
    "list_pending_approvals",
    {
      title: "List pending approvals",
      description:
        "Everything waiting for a human decision: proposed posts, drafted replies, and memory changes.",
      inputSchema: {},
    },
    async () => {
      const items = await approvals.listInbox(db, workspaceId);
      if (items.length === 0) {
        return { content: [{ type: "text", text: "The approval inbox is empty." }] };
      }
      const lines = items.map(
        (item) =>
          `- [${item.kind}] ${item.id}\n  ${item.title}${item.accountHandle ? ` (@${item.accountHandle})` : ""}\n  ${item.body.slice(0, 240)}${item.suggestedSlotAt ? `\n  suggested: ${item.suggestedSlotAt.toISOString()}` : ""}`,
      );
      return {
        content: [
          {
            type: "text",
            text: `${items.length} item(s) awaiting review:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "approve",
    {
      title: "Approve an item",
      description:
        "Approve a proposed post or drafted reply. A post with a suggested time is scheduled at the same moment.",
      inputSchema: {
        id: z.string().describe("The inbox item id"),
        kind: z.enum(["post", "reply"]).default("post"),
        text: z
          .string()
          .optional()
          .describe("Replacement text, to approve with an edit"),
      },
    },
    async ({ id, kind, text }) => {
      if (kind === "reply") {
        await approvals.approveReplyDraft(
          db,
          id,
          actor,
          text ? { text, media: [] } : undefined,
        );
        return { content: [{ type: "text", text: "Reply approved and queued to send." }] };
      }

      const result = await approvals.approvePost(db, id, actor, {
        ...(text ? { content: { text, media: [] } } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: result.scheduledAt
              ? `Approved and scheduled for ${result.scheduledAt.toISOString()}.`
              : "Approved. It needs a time before it will publish.",
          },
        ],
      };
    },
  );

  server.registerTool(
    "reject",
    {
      title: "Reject an item",
      description: "Reject a proposed post or drafted reply, optionally saying why.",
      inputSchema: {
        id: z.string(),
        kind: z.enum(["post", "reply"]).default("post"),
        reason: z.string().optional(),
      },
    },
    async ({ id, kind, reason }) => {
      if (kind === "reply") {
        await approvals.rejectReplyDraft(db, id, actor);
      } else {
        await approvals.rejectPost(db, id, actor, reason);
      }
      return { content: [{ type: "text", text: "Rejected." }] };
    },
  );

  server.registerTool(
    "request_changes",
    {
      title: "Send a post back for rework",
      description:
        "Return a proposed post to the agent with feedback instead of rejecting it outright.",
      inputSchema: { id: z.string(), feedback: z.string() },
    },
    async ({ id, feedback }) => {
      await approvals.requestChanges(db, id, actor, feedback);
      return {
        content: [{ type: "text", text: "Sent back for rework with your feedback." }],
      };
    },
  );

  server.registerTool(
    "propose_post",
    {
      title: "Propose a post",
      description:
        "Put a post into the approval queue for a connected account. Use list_accounts first to find the account id.",
      inputSchema: {
        accountId: z.string(),
        text: z.string(),
        suggestedSlotAt: z.string().optional().describe("ISO 8601 timestamp"),
        reasoning: z.string().optional(),
      },
    },
    async ({ accountId, text, suggestedSlotAt, reasoning }) => {
      const [account] = await db
        .select()
        .from(schema.linkedAccounts)
        .where(
          and(
            eq(schema.linkedAccounts.id, accountId),
            eq(schema.linkedAccounts.workspaceId, workspaceId),
          ),
        );
      if (!account) {
        return {
          content: [{ type: "text", text: "No such account in this workspace." }],
          isError: true,
        };
      }

      const [created] = await db
        .insert(schema.posts)
        .values({
          workspaceId,
          accountId,
          status: "pending_approval",
          content: { text, media: [] },
          suggestedSlotAt: suggestedSlotAt ? new Date(suggestedSlotAt) : null,
          reasoning: reasoning ?? null,
          createdByActor: actor,
        })
        .returning();

      await audit.record(db, {
        workspaceId,
        entityType: "post",
        entityId: created!.id,
        action: "propose",
        toStatus: "pending_approval",
        actor,
      });

      return {
        content: [
          { type: "text", text: `Proposed for @${account.handle}. Id: ${created!.id}` },
        ],
      };
    },
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List connected accounts",
      description: "The social accounts this workspace can publish to.",
      inputSchema: {},
    },
    async () => {
      const rows = await db
        .select()
        .from(schema.linkedAccounts)
        .where(eq(schema.linkedAccounts.workspaceId, workspaceId));
      return {
        content: [
          {
            type: "text",
            text: rows
              .map((r) => `- ${r.id} — @${r.handle} on ${r.connectorId}`)
              .join("\n"),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_analytics_summary",
    {
      title: "Get analytics summary",
      description:
        "Impressions, engagement rate, follower count and the best posts over a recent window.",
      inputSchema: { days: z.number().int().min(1).max(90).default(7) },
    },
    async ({ days }) => {
      const [summary, top] = await Promise.all([
        analytics.summary(db, workspaceId, days),
        analytics.topPosts(db, workspaceId, 3),
      ]);
      const best = top
        .map(
          (p) =>
            `  - "${p.text.slice(0, 80)}" — ${p.impressions} impressions, ${(p.engagementRate * 100).toFixed(1)}% engagement`,
        )
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: [
              `Last ${days} days:`,
              `  posts published: ${summary.postCount}`,
              `  impressions: ${summary.impressions}`,
              `  likes: ${summary.likes}, reposts: ${summary.reposts}, replies: ${summary.replies}`,
              `  followers: ${summary.followers}`,
              `  engagement rate: ${(summary.engagementRate * 100).toFixed(2)}%`,
              best ? `\nBest performing:\n${best}` : "",
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_strategy",
    {
      title: "Get brand memory",
      description:
        "The brand brief, current strategy, and accumulated learnings that guide what gets posted.",
      inputSchema: {},
    },
    async () => {
      const [brief, strategy, learnings] = await Promise.all([
        memory.readMemory(db, workspaceId, "brand_brief"),
        memory.readMemory(db, workspaceId, "strategy"),
        memory.readMemory(db, workspaceId, "learnings"),
      ]);
      return {
        content: [
          {
            type: "text",
            text: [
              `## Brand brief\n${brief?.contentMd ?? "(not written yet)"}`,
              `## Strategy\n${strategy?.contentMd ?? "(not written yet)"}`,
              `## Learnings\n${learnings?.contentMd ?? "(none yet)"}`,
            ].join("\n\n"),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_recent_activity",
    {
      title: "Get recent activity",
      description:
        "What has happened lately and who caused it — human, agent, autonomy rule, API or MCP client.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
    },
    async ({ limit }) => {
      const entries = await audit.listAudit(db, workspaceId, { limit });
      return {
        content: [
          {
            type: "text",
            text: entries
              .map(
                (e) =>
                  `${e.createdAt.toISOString()} ${e.actor.kind} ${e.action} ${e.entityType}${e.toStatus ? ` → ${e.toStatus}` : ""}`,
              )
              .join("\n"),
          },
        ],
      };
    },
  );

  return server;
}

/** Post ids and statuses, used by the HTTP transport for quick lookups. */
export async function recentPosts(db: Database, workspaceId: string) {
  return db
    .select({
      id: schema.posts.id,
      status: schema.posts.status,
      content: schema.posts.content,
    })
    .from(schema.posts)
    .where(eq(schema.posts.workspaceId, workspaceId))
    .orderBy(desc(schema.posts.createdAt))
    .limit(20);
}
