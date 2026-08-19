import { Module } from "@nestjs/common";
import { ChatController } from "./chat.controller.js";
import { EventsController } from "./events.controller.js";
import { HealthController } from "./health.controller.js";
import { LabController } from "./lab.controller.js";
import { MediaController } from "./media.controller.js";
import { McpController } from "./mcp.controller.js";
import { PlansController } from "./plans.controller.js";
import { PostsController } from "./posts.controller.js";
import { WorkspaceController } from "./workspace.controller.js";
import { PomeloController } from "../pomelo/pomelo.controller.js";
import { PlanScheduleModule } from "../worker/plan-schedule.module.js";
import { MastraModule } from "../infra/mastra.module.js";

/**
 * The HTTP surface: REST under /api/v1, the MCP endpoint, the live event
 * stream, and Pomelo's own API. Controllers are thin — guard, validate, call
 * into @zest/core, serialize.
 */
@Module({
  imports: [PlanScheduleModule, MastraModule],
  controllers: [
    HealthController,
    PostsController,
    PlansController,
    WorkspaceController,
    LabController,
    ChatController,
    MediaController,
    EventsController,
    McpController,
    PomeloController,
  ],
})
export class ApiModule {}
