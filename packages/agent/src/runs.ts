import { eq, schema, type Database } from "@zest/db";
import { emit, type EventPublisher } from "@zest/core";
import type { RoleName } from "./agents.ts";

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
    model?: string;
    publisher?: EventPublisher;
    /** Which programme this stage serves, and the account it writes for. */
    planId?: string | null;
    accountId?: string | null;
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
export function toTranscript(steps: unknown): unknown[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => {
    const s = step as {
      text?: string;
      toolCalls?: { toolName?: string; args?: unknown }[];
      toolResults?: { toolName?: string; result?: unknown }[];
    };
    return {
      text: s.text,
      toolCalls: s.toolCalls?.map((c) => ({ tool: c.toolName, args: c.args })),
      toolResults: s.toolResults?.map((r) => ({ tool: r.toolName, result: r.result })),
    };
  });
}
