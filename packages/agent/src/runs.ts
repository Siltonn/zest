import { and, eq, lt, schema, type Database } from "@zest/db";
import { emit, type EventPublisher } from "@zest/core";
import type { RoleName } from "./agents/shared.ts";

/**
 * Run bookkeeping.
 *
 * Every invocation gets a row with its transcript, so a proposal in the inbox
 * can be traced back to the tools that produced it. This is deliberately our
 * own table rather than the framework's tracing: run replay is a product
 * feature the operator uses, not a debugging aid we might turn off.
 */

export type TriggerName =
  | "cron_plan"
  | "event_reply"
  | "cron_analyze"
  | "chat"
  | "mcp"
  | "manual";

export type RunHandle = {
  id: string;
  workspaceId: string;
  publisher?: EventPublisher;
};

export async function startRun(
  db: Database,
  input: {
    workspaceId: string;
    trigger: TriggerName;
    role?: RoleName;
    model?: string | null;
    publisher?: EventPublisher;
    /** Which programme this stage serves, and the account it writes for. */
    planId?: string | null;
    accountId?: string | null;
    /** Absent on a research run, which becomes the cycle id for the rest. */
    cycleId?: string | null;
  },
): Promise<RunHandle> {
  const [run] = await db
    .insert(schema.agentRuns)
    .values({
      workspaceId: input.workspaceId,
      trigger: input.trigger,
      // `assistant` is a chat persona, not one of the pipeline roles the
      // schema enumerates, so it is recorded without a role.
      role: input.role && input.role !== "assistant" ? input.role : null,
      planId: input.planId ?? null,
      accountId: input.accountId ?? null,
      cycleId: input.cycleId ?? null,
      model: input.model ?? null,
      status: "running",
    })
    .returning();

  if (!run) throw new Error("Could not start an agent run");
  return { id: run.id, workspaceId: input.workspaceId, publisher: input.publisher };
}

export async function reportProgress(
  handle: RunHandle,
  phase: string,
  detail?: string,
  role?: string,
): Promise<void> {
  if (!handle.publisher) return;
  await emit(handle.publisher, {
    type: "run.progress",
    workspaceId: handle.workspaceId,
    runId: handle.id,
    phase,
    detail,
    role,
  });
}

export async function finishRun(
  db: Database,
  handle: RunHandle,
  result: {
    transcript?: unknown[];
    /** The role's final text — the next stage reads its input from here. */
    output?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    error?: string;
  },
): Promise<void> {
  await db
    .update(schema.agentRuns)
    .set({
      status: result.error ? "failed" : "succeeded",
      transcript: result.transcript ?? [],
      output: result.output ?? null,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      costUsd: String(result.costUsd ?? 0),
      errorMessage: result.error ?? null,
      endedAt: new Date(),
    })
    .where(eq(schema.agentRuns.id, handle.id));

  await reportProgress(handle, result.error ? "failed" : "done", result.error);
}

export async function readRun(
  db: Database,
  runId: string,
): Promise<typeof schema.agentRuns.$inferSelect | null> {
  const [run] = await db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, runId));
  return run ?? null;
}

/**
 * Normalises whatever the model returned into a transcript we can replay in the
 * UI: which tools ran, with what arguments, and what came back.
 */
/**
 * Mastra wraps each tool call as `{ type, runId, from, payload: { toolName, args } }`
 * rather than exposing `toolName` at the top level. Reading the flat shape
 * silently produced `undefined` for every name, which meant blank chips on the
 * team page and a transcript that could not answer "what did it actually do" —
 * the one question the transcript exists for. Both shapes are read so a future
 * SDK change flattening this does not break it again.
 */
type RawToolEntry = {
  toolName?: string;
  args?: unknown;
  result?: unknown;
  payload?: { toolName?: string; args?: unknown; result?: unknown };
};

function readTool(entry: RawToolEntry): { tool?: string; args?: unknown; result?: unknown } {
  return {
    tool: entry.payload?.toolName ?? entry.toolName,
    args: entry.payload?.args ?? entry.args,
    result: entry.payload?.result ?? entry.result,
  };
}

export function toTranscript(steps: unknown): unknown[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => {
    const s = step as {
      text?: string;
      finishReason?: string;
      toolCalls?: RawToolEntry[];
      toolResults?: RawToolEntry[];
    };
    return {
      text: s.text,
      // Recorded because "why did it stop" is the first question when a stage
      // succeeds and produces nothing: `length` means it ran out of room.
      finishReason: s.finishReason,
      toolCalls: s.toolCalls?.map((c) => {
        const { tool, args } = readTool(c);
        return { tool, args };
      }),
      toolResults: s.toolResults?.map((r) => {
        const { tool, result } = readTool(r);
        return { tool, result };
      }),
    };
  });
}

/**
 * How long a run may sit in `running` before it is presumed dead.
 *
 * A full planning stage is minutes, not tens of minutes. Generous enough that a
 * slow model is not declared dead mid-thought, short enough that a killed
 * worker does not leave a spinner on the team page forever.
 */
const STALE_RUN_MINUTES = 20;

/**
 * Fails runs whose process went away.
 *
 * Nothing times out `agent.generate`, and a worker killed mid-run leaves its
 * row in `running` permanently: the team page spins, the dashboard counts it as
 * live, and no retry ever happens because the job is already gone. The
 * publishing path has recovered orphaned claims since M2 for the same reason —
 * this is that sweep for agent runs.
 */
export async function reapStaleRuns(db: Database): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RUN_MINUTES * 60_000);

  const reaped = await db
    .update(schema.agentRuns)
    .set({
      status: "failed",
      endedAt: new Date(),
      errorMessage: `No result after ${STALE_RUN_MINUTES} minutes — the run was abandoned.`,
    })
    .where(
      and(
        eq(schema.agentRuns.status, "running"),
        lt(schema.agentRuns.startedAt, cutoff),
      ),
    )
    .returning({ id: schema.agentRuns.id });

  return reaped.length;
}
