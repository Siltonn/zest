import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, desc, eq, schema, type Database } from "@zest/db";
import { analytics, approvals, audit, changeRequests, memory, plans } from "@zest/core";
import type { Actor, ApiScope } from "@zest/shared";
import { z } from "zod";

/**
 * The MCP surface.
 *
 * Zest is an agent, and it is also something other agents can drive: Claude
 * connects to a deployed instance and reviews the queue, approves work, or asks
 * how the week went. These tools call the same `@zest/core` services the REST
 * API and the queue processors use, so an approval over MCP is
 * indistinguishable from one clicked in the web UI — except in the audit log,
 * which records exactly which client did it, and which user (if any) stood
 * behind it.
 *
 * Two properties are load-bearing:
 *
 *  1. **The tool list is the permission model.** A server is built per request
 *     from the credential's scopes, so a read-only key never even sees
 *     `approve` — there is nothing to call, not merely something that refuses.
 *
 *  2. **Proposing and deciding are different postures.** `propose_post` always
 *     lands in the approval inbox, whatever autonomy rules say: autonomy is
 *     trust granted to *this workspace's own agent*, and an external MCP client
 *     is not that agent. Deciding (`approve`/`reject`) needs the `approve`
 *     scope, and granting the agent standing autonomy additionally needs a
 *     user-backed session — a machine credential cannot widen the leash.
 */

export type McpContext = {
  db: Database;
  workspaceId: string;
  actor: Actor;
  /** What the presented credential may do; tools outside it are not registered. */
  scopes: ReadonlySet<ApiScope>;
  /**
   * Releasing a planned week means enqueuing work, and the queue belongs to the
   * server rather than this package — so the host supplies the callback and
   * this stays a pure view over domain services.
   */
  onApprovePlan?: (planId: string, accountIds: string[]) => Promise<void>;
};

/** Spec annotations: what a client may safely assume about each tool. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export function createZestMcpServer(context: McpContext): McpServer {
  const server = new McpServer({
    name: "zest",
    version: "0.1.0",
  });

  const { db, workspaceId, actor, scopes, onApprovePlan } = context;
  const can = (scope: ApiScope) => scopes.has(scope);

  if (can("read")) {
    server.registerTool(
      "list_pending_approvals",
      {
        title: "List pending approvals",
        description:
          "Everything waiting for a human decision: proposed posts, drafted replies, and memory changes.",
        inputSchema: {},
        annotations: READ_ONLY,
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
      "list_accounts",
      {
        title: "List connected accounts",
        description: "The social accounts this workspace can publish to.",
        inputSchema: {},
        annotations: READ_ONLY,
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
        annotations: READ_ONLY,
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
        annotations: READ_ONLY,
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
        annotations: READ_ONLY,
      },
      async ({ limit }) => {
        const { entries } = await audit.listAudit(db, workspaceId, { limit });
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
  }

  if (can("propose")) {
    server.registerTool(
      "propose_post",
      {
        title: "Propose a post",
        description:
          "Put a post into the approval queue for a connected account. It always waits for review — MCP clients propose, they do not publish. Use list_accounts first to find the account id.",
        inputSchema: {
          accountId: z.string(),
          text: z.string(),
          suggestedSlotAt: z.string().optional().describe("ISO 8601 timestamp"),
          reasoning: z.string().optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
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
  }

  if (can("approve")) {
    server.registerTool(
      "approve",
      {
        title: "Approve an item",
        description:
          "Approve anything in the inbox: a proposed post, a drafted reply, a rewrite of a memory document, or a planned week. A post with a suggested time is scheduled at the same moment. Approving an autonomy request additionally requires a user-authorized session — API keys are refused.",
        inputSchema: {
          id: z.string().describe("The inbox item id"),
          kind: z
            .enum(["post", "reply", "memory", "autonomy_request", "plan"])
            .default("post")
            .describe("The kind reported by list_pending_approvals"),
          text: z
            .string()
            .optional()
            .describe("Replacement text, to approve with an edit (posts and replies only)"),
        },
        annotations: {
          readOnlyHint: false,
          // Approving is the point of no return: a scheduled post will publish
          // to an external network without another confirmation.
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ id, kind, text }) => {
        // A planned week releases to the writers rather than publishing
        // anything: approving here means "yes, write these".
        if (kind === "plan") {
          const accountIds = await plans.accountsWithPendingItems(db, workspaceId, id);
          if (accountIds.length === 0) {
            return {
              content: [
                { type: "text", text: "Nothing is waiting to be written on that plan." },
              ],
            };
          }
          await onApprovePlan?.(id, accountIds);
          return {
            content: [
              {
                type: "text",
                text: `Approved. ${accountIds.length} writer(s) will turn those topics into drafts, which come back for approval.`,
              },
            ],
          };
        }

        // Approving a memory rewrite or an autonomy request is not a status
        // flip — it rewrites the document the next run reads, or grants a
        // standing rule. Same core function the web UI calls, including the
        // rule that autonomy grants must trace to a person.
        if (kind === "memory" || kind === "autonomy_request") {
          const result = await changeRequests.approve(db, workspaceId, id, actor);
          return {
            content: [
              {
                type: "text",
                text:
                  result.kind === "memory"
                    ? `Approved. ${result.applied} is now the version the agent reads.`
                    : `Approved. The agent may now ${result.applied.replace(/_/g, " ")} without asking; revoke it any time.`,
              },
            ],
          };
        }

        if (kind === "reply") {
          await approvals.approveReplyDraft(
            db,
            workspaceId,
            id,
            actor,
            text ? { text, media: [] } : undefined,
          );
          return { content: [{ type: "text", text: "Reply approved and queued to send." }] };
        }

        const result = await approvals.approvePost(db, workspaceId, id, actor, {
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
        description:
          "Reject anything in the inbox — a post, a reply, a memory rewrite, or an autonomy request — optionally saying why.",
        inputSchema: {
          id: z.string(),
          kind: z
            .enum(["post", "reply", "memory", "autonomy_request", "plan"])
            .default("post"),
          reason: z.string().optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ id, kind, reason }) => {
        if (kind === "plan") {
          const found = await plans.readPlan(db, workspaceId, id);
          for (const item of (found?.items ?? []).filter((i) => i.status === "planned")) {
            await plans.skipItem(db, workspaceId, item.id);
          }
        } else if (kind === "memory" || kind === "autonomy_request") {
          await changeRequests.reject(db, workspaceId, id, actor, reason);
        } else if (kind === "reply") {
          await approvals.rejectReplyDraft(db, workspaceId, id, actor);
        } else {
          await approvals.rejectPost(db, workspaceId, id, actor, reason);
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
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ id, feedback }) => {
        await approvals.requestChanges(db, workspaceId, id, actor, feedback);
        return {
          content: [{ type: "text", text: "Sent back for rework with your feedback." }],
        };
      },
    );
  }

  // ── Prompts ───────────────────────────────────────────────────────────
  //
  // Tools are what a client *can* do; prompts are what it should offer to do.
  // Without them a connected Claude shows a bare tool list and the operator
  // has to invent the phrasing — which is the difference between an
  // integration that gets used and one that gets configured once and
  // forgotten. Each prompt only appears when the scopes can actually run it.

  if (can("read")) {
    server.registerPrompt(
      "review_queue",
      {
        title: "Review my approval queue",
        description:
          "Walk everything waiting for a decision — posts, replies, planned weeks, memory rewrites — and recommend an action for each.",
      },
      () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Call list_pending_approvals and walk what is waiting.",
                "",
                "For each item say what it is, what it would do if approved, and",
                "what you would do — approve, send back with a note, or reject —",
                "with one line of reasoning. Group by kind and lead with anything",
                "time-sensitive.",
                "",
                "Do not approve anything until I say so.",
              ].join("\n"),
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "week_in_review",
      {
        title: "How did last week go?",
        description:
          "Summarise performance, name what worked, and propose what to change — grounded in the numbers rather than vibes.",
      },
      () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Call get_analytics_summary, get_recent_activity and get_strategy.",
                "",
                "Tell me: what actually moved, which posts did the work and what",
                "they had in common, and one concrete change to the strategy for",
                "next week. If the numbers are too thin to conclude anything, say",
                "that instead of inventing a pattern.",
              ].join("\n"),
            },
          },
        ],
      }),
    );
  }

  if (can("propose")) {
    server.registerPrompt(
      "draft_for_account",
      {
        title: "Draft a post for one account",
        description:
          "Write in a specific account's voice and send it for approval, using its voice card rather than a generic tone.",
        argsSchema: {
          handle: z.string().describe("The account handle, without the @"),
          topic: z.string().describe("What the post should be about"),
        },
      },
      ({ handle, topic }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Draft a post for @${handle} about: ${topic}`,
                "",
                "First call list_accounts to find its id, and get_strategy to read",
                "the brand brief and that account's voice card. Match the voice —",
                "a founder account and a company account must not sound alike.",
                "",
                "Then call propose_post. It goes to the approval inbox, not live.",
              ].join("\n"),
            },
          },
        ],
      }),
    );
  }

  // ── Resources ─────────────────────────────────────────────────────────
  //
  // The documents a client should be able to read without spending a tool call,
  // and which make its answers specific instead of generic.

  if (can("read")) {
    server.registerResource(
      "brand-brief",
      "zest://memory/brand_brief",
      {
        title: "Brand brief",
        description: "Who this brand is, who it talks to, and what it never says.",
        mimeType: "text/markdown",
      },
      async (uri) => {
        const doc = await memory.readMemory(db, workspaceId, "brand_brief");
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text: doc?.contentMd ?? "No brand brief has been written yet.",
            },
          ],
        };
      },
    );

    server.registerResource(
      "strategy",
      "zest://memory/strategy",
      {
        title: "Current strategy",
        description: "The plan and cadence the agent is working to.",
        mimeType: "text/markdown",
      },
      async (uri) => {
        const doc = await memory.readMemory(db, workspaceId, "strategy");
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text: doc?.contentMd ?? "No strategy recorded yet.",
            },
          ],
        };
      },
    );

    server.registerResource(
      "plans",
      "zest://plans",
      {
        title: "Content programmes",
        description:
          "Every plan, its cadence, the accounts it writes for, and what is still unwritten.",
        mimeType: "text/markdown",
      },
      async (uri) => {
        const all = await plans.listPlans(db, workspaceId);
        const accounts = await db
          .select()
          .from(schema.linkedAccounts)
          .where(eq(schema.linkedAccounts.workspaceId, workspaceId));

        const text =
          all.length === 0
            ? "No plans yet. Without one, nothing is scheduled."
            : all
                .map((plan) =>
                  [
                    `## ${plan.name} (${plan.status}, ${plan.schedule})`,
                    plan.objective ?? "",
                    `Accounts: ${plan.accountIds
                      .map(
                        (id) =>
                          `@${accounts.find((a) => a.id === id)?.handle ?? "unknown"}`,
                      )
                      .join(", ")}`,
                    `${plan.itemCounts.planned} planned · ${plan.itemCounts.written} written`,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                )
                .join("\n\n");

        return {
          contents: [{ uri: uri.href, mimeType: "text/markdown", text }],
        };
      },
    );
  }

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
