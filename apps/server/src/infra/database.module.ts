import { Global, Module } from "@nestjs/common";
import { createDatabase, type Database } from "@zest/db";
import { loadEnv } from "../config.js";

export const DATABASE = Symbol("DATABASE");

/**
 * The Drizzle instance is the only thing Nest injects for data access. Domain
 * logic lives in `@zest/core` as plain functions that take a Database, so it
 * stays runnable outside Nest (scripts, tests, the MCP server).
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (): Database => createDatabase(loadEnv().DATABASE_URL),
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
