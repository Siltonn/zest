import { All, Controller, Inject, Req, Res, UseGuards } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createZestMcpServer } from "@zest/mcp";
import type { Database } from "@zest/db";
import { DATABASE } from "../infra/database.module.js";
import { QUEUE_AGENT_RUN } from "../queue/queue.constants.js";
import { McpAuthGuard } from "../auth/mcp-auth.guard.js";
import type { AuthedRequest } from "../auth/workspace.guard.js";

/**
 * MCP over streamable HTTP, mounted on the deployed instance.
 *
 * Remote transport rather than stdio, because Zest runs as a server. Two ways
 * in (see McpAuthGuard): an OAuth flow the client discovers on its own — what
 * Claude's custom connectors use — or a workspace API key for clients that
 * send headers, like Claude Code. The actor recorded for every mutation says
 * `mcp`, carrying the key id or the authorizing user, so the audit page can
 * show which changes came from an external agent and on whose authority.
 *
 * The tool list itself is scope-shaped: the guard resolves what the credential
 * may do, and the server is built per request with exactly those tools.
 */
@Controller("mcp")
@UseGuards(McpAuthGuard)
export class McpController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @InjectQueue(QUEUE_AGENT_RUN) private readonly agentQueue: Queue,
  ) {}

  @All()
  async handle(@Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    // Stateless means no server→client stream and no session to terminate, so
    // GET and DELETE get the spec's 405 (§ Streamable HTTP). Left to the SDK,
    // a GET would open an SSE stream that nothing will ever write to — every
    // connected client would hold one open socket per reconnect, forever.
    if (req.method !== "POST") {
      res
        .status(405)
        .set("Allow", "POST")
        .json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        });
      return;
    }

    const server = createZestMcpServer({
      db: this.db,
      // Approving a planned week releases it to the writers, which is queue
      // work — supplied here so the MCP package stays free of infrastructure.
      onApprovePlan: async (planId, accountIds) => {
        for (const accountId of accountIds) {
          await this.agentQueue.add("plan-copy", {
            workspaceId: req.workspaceId,
            planId,
            accountId,
          });
        }
      },
      workspaceId: req.workspaceId,
      actor: req.actor,
      scopes: req.scopes,
    });

    // Stateless: a fresh server and transport per request, so there is no
    // session state to leak between callers or to lose on a restart. The
    // trade-off is no server-initiated messages (elicitation, notifications)
    // — acceptable while every tool here is request/response.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Plain JSON responses instead of SSE: nothing streams in a stateless
      // setup, and JSON survives every proxy between here and the client.
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req as Request, res, req.body);
  }
}
