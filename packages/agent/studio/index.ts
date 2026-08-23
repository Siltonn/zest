import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextWithMastra } from "@mastra/core/server";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { PostgresStore } from "@mastra/pg";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { createDatabase, eq, schema } from "@zest/db";
import { agent as agentActor } from "@zest/shared";
import { createMastra } from "../src/mastra.ts";
import { setToolContext } from "../src/context.ts";
import { hasModelAccess } from "../src/models.ts";
import { enableAssistantRecall } from "../src/recall.ts";
import { finishRun, startRun } from "../src/runs.ts";

/**
 * Mastra Studio, wired to a real workspace.
 *
 * Everywhere else the roles run headless: a cron fires, a workflow runs them in
 * order, and what you get afterwards is a transcript row. That is the right
 * shape for production and a poor one for development, where the question is
 * usually "why did the strategist decide that" and the only way to ask it was
 * to trigger a whole planning cycle and read the result. Studio gives the roles
 * a chat window, a tool inspector and a trace timeline instead.
 *
 * This file exists outside `src/` on purpose. It is development scaffolding —
 * it pulls in the observability exporters the server does not need — so it
 * stays out of `tsc`'s build and therefore out of the image.
 * `tsconfig.studio.json` typechecks it in place.
 */

/**
 * The roles import their model at construction, and every tool reaches for a
 * database, so both have to be present before the first agent is built. The
 * dev server is started by the Mastra CLI rather than by our own entry points,
 * and nothing in that chain reads `.env` from the repo root — same gap
 * `apps/server` fills in `loadEnv`, filled the same way.
 */
function findUp(marker: string): string | undefined {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, marker))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

const root = findUp("pnpm-workspace.yaml") ?? process.cwd();
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Studio talks to a real database — copy .env.example to .env and start Postgres (docker compose up -d postgres).",
  );
}
if (!hasModelAccess()) {
  throw new Error(
    "No LLM provider configured. Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY in .env — Studio has nothing to talk to without one.",
  );
}

const databaseUrl = process.env.DATABASE_URL;
const db = createDatabase(databaseUrl, { max: 4 });

// Same wiring as the server: recall on when the environment supports it, and
// one honest line about why when it does not.
const recall = await enableAssistantRecall(databaseUrl);
console.info(
  recall.enabled
    ? `[zest] assistant recall is on (embeddings: ${recall.model})`
    : `[zest] assistant recall is off: ${recall.reason}`,
);

/** Studio's request context panel sends JSON, so anything may arrive here. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Answers computed once and kept, since the middleware runs on every request
 * that can reach a tool and neither answer moves. Cached as promises so
 * concurrent requests share one
 * lookup rather than racing — and dropped again if the lookup fails, or the
 * first request against an empty database would poison every later one, which
 * is precisely the case whose error message says to go and seed it.
 */
function once<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = compute().catch((error: unknown) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

/**
 * Which workspace a Studio conversation acts on.
 *
 * `ZEST_STUDIO_WORKSPACE_ID` pins it, the request context panel overrides that
 * per conversation, and otherwise the oldest workspace wins — which on a seeded
 * development database is the demo one.
 */
const workspaces = new Map<string, Promise<string>>();
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const WHERE_FROM =
  " It came from ZEST_STUDIO_WORKSPACE_ID or the workspaceId in Studio's request context panel.";

function resolveWorkspace(requested?: string): Promise<string> {
  const pinned = requested ?? text(process.env.ZEST_STUDIO_WORKSPACE_ID);

  return once(workspaces, pinned ?? "", async () => {
    // Looked up rather than taken at its word. An id that does not exist would
    // otherwise fail as a foreign key violation on the run row — the wrong
    // error, on the wrong table, saying nothing about which setting was wrong.
    if (pinned && !UUID.test(pinned)) {
      throw new Error(`"${pinned}" is not a workspace id.${WHERE_FROM}`);
    }

    const [found] = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(pinned ? eq(schema.workspaces.id, pinned) : undefined)
      .orderBy(schema.workspaces.createdAt)
      .limit(1);

    if (found) return found.id;
    throw new Error(
      pinned
        ? `No workspace ${pinned} in this database.${WHERE_FROM}`
        : "No workspaces in this database. Run `pnpm demo` to seed one, or set ZEST_STUDIO_WORKSPACE_ID.",
    );
  });
}

/**
 * One run row per workspace, for the lifetime of the dev server.
 *
 * Not bookkeeping for its own sake: `posts`, `reply_drafts` and `audit_logs`
 * all carry an `agent_run_id` that references `agent_runs`, so a tool called
 * from Studio with an invented run id fails on a foreign key rather than
 * writing anything. The row is closed the moment it is opened — it is an anchor
 * for those references, not a run in progress, and leaving it open would only
 * hand it to `reapStaleRuns` twenty minutes later.
 *
 * The side effect is a welcome one: a proposal that appears in the inbox during
 * a Studio session is still traceable to where it came from.
 */
const sessionRuns = new Map<string, Promise<string>>();

function sessionRun(workspaceId: string): Promise<string> {
  return once(sessionRuns, workspaceId, async () => {
    const handle = await startRun(db, { workspaceId, trigger: "manual" });
    await finishRun(db, handle, { output: "Mastra Studio session" });
    return handle.id;
  });
}

export const mastra = createMastra({
  // The same store the server uses: the dev database's `mastra` schema. That
  // makes Studio's assistant threads the product's — a conversation started in
  // the web app opens in Studio with its history, and vice versa — and keeps
  // "Studio exercises what production runs" true of storage too. Traces and
  // eval scores land there as well; `DROP SCHEMA mastra CASCADE` resets it.
  storage: new PostgresStore({
    id: "zest-studio",
    connectionString: databaseUrl,
    schemaName: "mastra",
    max: 5,
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: "zest-studio",
        exporters: [new MastraStorageExporter()],
      },
    },
  }),
  server: {
    middleware: [
      {
        path: "/api/*",
        /**
         * The reason this file is more than a list of agents.
         *
         * Every tool starts with `readToolContext`, which wants a live database
         * handle, a workspace and an actor — none of which can be typed into
         * Studio's request context panel as JSON. Without this, the agents show
         * up, the chat works, and the first tool call fails. So the context is
         * assembled here and the panel is left for the parts that are genuinely
         * per-conversation: which workspace, and the plan or account a role is
         * scoped to.
         */
        handler: async (c: ContextWithMastra, next: () => Promise<void>) => {
          const requestContext = c.get("requestContext");
          const requested =
            text(requestContext.get("workspaceId")) ??
            c.req.header("x-zest-workspace");

          // Reads get the workspace's resource id and nothing more. The UI
          // lists chat threads with its own per-browser resource id; forcing
          // ours on the read path is what makes the sidebar find the threads
          // the write path saved. Quietly, though — Studio polls constantly,
          // and a misconfigured workspace should surface once, on an action,
          // not as a log flood from every listing.
          if (c.req.method !== "POST" && c.req.method !== "PUT") {
            try {
              requestContext.set(MASTRA_RESOURCE_ID_KEY, await resolveWorkspace(requested));
            } catch {
              // The POST path still reports this loudly.
            }
            return next();
          }

          const workspaceId = await resolveWorkspace(requested);
          const runId = await sessionRun(workspaceId);

          // The assistant's chat threads belong to the workspace, exactly as
          // they do in the product. Forcing the resource id here keeps every
          // Studio conversation under it, whatever the UI would have sent.
          requestContext.set(MASTRA_RESOURCE_ID_KEY, workspaceId);

          setToolContext(requestContext, {
            db,
            workspaceId,
            runId,
            actor: agentActor(runId, "studio"),
            // `add_plan_items` refuses to write without a plan, and the
            // copywriter's tools want the account they are writing for. Both
            // come from the workflow in production; in Studio they come from
            // whoever is debugging.
            planId: text(requestContext.get("planId")),
            accountId: text(requestContext.get("accountId")),
            // A model id typed into the panel reaches every stage the same way
            // ZEST_MODEL would.
            model: text(requestContext.get("model")),
          });

          await next();
        },
      },
    ],
  },
});
