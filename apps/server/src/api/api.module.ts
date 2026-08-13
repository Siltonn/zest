import { Module } from "@nestjs/common";
import { EventsController } from "./events.controller.js";
import { HealthController } from "./health.controller.js";
import { LabController } from "./lab.controller.js";
import { MediaController } from "./media.controller.js";
import { McpController } from "./mcp.controller.js";
import { PostsController } from "./posts.controller.js";
import { WorkspaceController } from "./workspace.controller.js";
import { PomeloController } from "../pomelo/pomelo.controller.js";

/**
 * The HTTP surface: REST under /api/v1, the MCP endpoint, the live event
 * stream, and Pomelo's own API. Controllers are thin — guard, validate, call
 * into @zest/core, serialize.
 */
@Module({
  controllers: [
    HealthController,
    PostsController,
    WorkspaceController,
    LabController,
    MediaController,
    EventsController,
    McpController,
    PomeloController,
  ],
})
export class ApiModule {}
