import { Controller, Get, Inject } from "@nestjs/common";
import { sql, type Database } from "@zest/db";
import { DATABASE } from "../infra/database.module.js";
import { loadEnv } from "../config.js";

@Controller()
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get("health")
  async health(): Promise<{ status: string; mode: string; database: string }> {
    let database = "up";
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      database = "down";
    }
    return { status: "ok", mode: loadEnv().MODE, database };
  }
}
