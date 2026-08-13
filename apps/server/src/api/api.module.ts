import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";

/**
 * HTTP surface: REST under /api/v1, plus /mcp, /events and /pomelo as those
 * land. Controllers stay thin — auth guard, zod validation, call into
 * @zest/core, serialize.
 */
@Module({
  controllers: [HealthController],
})
export class ApiModule {}
