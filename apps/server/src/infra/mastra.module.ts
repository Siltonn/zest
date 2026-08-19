import { Module } from "@nestjs/common";
import { PostgresStore } from "@mastra/pg";
import { createMastra } from "@zest/agent";
import { loadEnv } from "../config.js";

export const MASTRA = Symbol("MASTRA");

/**
 * The server's Mastra instance: the shared agent/workflow registry, plus a
 * Postgres store so the assistant's conversation memory has somewhere to live.
 *
 * Everything Mastra persists goes into its own `mastra` schema — the product's
 * tables stay in `public` under Drizzle's migrations, and the two never share
 * DDL. The rule of thumb: anything approved, audited or published lives in our
 * tables; the chat transcript lives in Mastra's. Dropping the `mastra` schema
 * resets conversations and nothing else.
 *
 * Imported by the API module only. The worker runs the pipeline, whose agents
 * carry no memory — constructing a second store there would just race this
 * one's table creation at boot.
 */
@Module({
  providers: [
    {
      provide: MASTRA,
      useFactory: () => {
        const env = loadEnv();
        return createMastra({
          storage: new PostgresStore({
            id: "zest-mastra",
            connectionString: env.DATABASE_URL,
            schemaName: "mastra",
            // A deliberately small second pool — the product's own postgres.js
            // pool does the heavy lifting; this one only reads and writes chat.
            max: 5,
          }),
        });
      },
    },
  ],
  exports: [MASTRA],
})
export class MastraModule {}
