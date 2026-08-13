import { All, Controller, Inject, Req, Res, UseGuards } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createZestMcpServer } from "@zest/mcp";
import type { Database } from "@zest/db";
import { DATABASE } from "../infra/database.module.js";
import { QUEUE_AGENT_RUN } from "../queue/queue.constants.js";
import { WorkspaceGuard, type AuthedRequest } from "../auth/workspace.guard.js";

/**
 * MCP over streamable HTTP, mounted on the deployed instance.
 *
 * Remote transport rather than stdio, because Zest runs as a server: a user
 * points Claude Desktop at their instance URL with an API key and is connected.
 * The API-key guard identifies the workspace, and the actor recorded for every
 * mutation says `mcp`, so the audit page can show which changes came from an
 * external agent.
 */
@Controller("mcp")
@UseGuards(WorkspaceGuard)
export class McpController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @InjectQueue(QUEUE_AGENT_RUN) private readonly agentQueue: Queue,
  ) {}

  @All()
  async handle(@Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
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
      actor:
        req.actor.kind === "api"
          ? { kind: "mcp", clientId: req.actor.keyId }
          : req.actor,
    });

    // Stateless: a fresh server and transport per request, so there is no
    // session state to leak between callers or to lose on a restart.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req as Request, res, req.body);
  }
}
