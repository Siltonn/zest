import { schema, eq, and, type Database } from "@zest/db";
import { memory } from "@zest/core";
import type { EventPublisher } from "@zest/core";
import { agent as agentActor } from "@zest/shared";
import { createRoleAgent, type RoleName } from "./agents.ts";
import { buildRequestContext } from "./context.ts";
import { NoModelConfiguredError, hasModelAccess } from "./models.ts";
import {
  finishRun,
  reportProgress,
  startRun,
  toTranscript,
  type TriggerName,
} from "./runs.ts";

/**
 * The operating loops.
 *
 * Orchestration lives here in ordinary code rather than in the model: the
 * sequence researcher → strategist → copywriter is fixed, each stage's output
 * is inspectable, and a failure in one stage does not leave the others in an
 * ambiguous state. The model decides what to say; the workflow decides what
 * happens next.
 */

export type RunOptions = {
  db: Database;
  workspaceId: string;
  publisher?: EventPublisher;
  model?: string;
};

type RoleResult = { text: string; transcript: unknown[] };

async function runRole(
  options: RunOptions,
  role: RoleName,
  prompt: string,
  runId: string,
): Promise<RoleResult> {
  const agent = createRoleAgent(role, options.model);
  const result = await agent.generate(prompt, {
    requestContext: buildRequestContext({
      db: options.db,
      workspaceId: options.workspaceId,
      actor: agentActor(runId, role),
      runId,
      publisher: options.publisher,
    }),
    maxSteps: 18,
  });

  return {
    text: result.text ?? "",
    transcript: toTranscript((result as { steps?: unknown }).steps),
  };
}

export type PlanningResult = {
  runId: string;
  briefing: string;
  plan: string;
  proposals: number;
  skipped?: string;
};

/**
 * The daily planning cycle. Three roles in sequence, each seeing the previous
 * one's output — research grounds the plan, the plan constrains the writing.
 */
export async function runPlanning(options: RunOptions): Promise<PlanningResult> {
  const { db, workspaceId } = options;

  if (!hasModelAccess()) {
    // The platform loop keeps working without a key; only the thinking stops.
    return {
      runId: "",
      briefing: "",
      plan: "",
      proposals: 0,
      skipped: new NoModelConfiguredError().message,
    };
  }

  const handle = await startRun(db, {
    workspaceId,
    trigger: "cron_plan",
    publisher: options.publisher,
    model: options.model,
  });

  const before = await countProposals(db, workspaceId);
  const transcript: unknown[] = [];

  try {
    const context = await memory.buildContext(db, workspaceId);

    await reportProgress(handle, "researching", "Looking at trends and recent performance", "researcher");
    const research = await runRole(
      options,
      "researcher",
      `${context}\n\nResearch what this brand should post about this week.`,
      handle.id,
    );
    transcript.push({ role: "researcher", ...research });

    await reportProgress(handle, "planning", "Turning research into a weekly plan", "strategist");
    const plan = await runRole(
      options,
      "strategist",
      `${context}\n\n## Research briefing\n\n${research.text}\n\nBuild the plan for the coming week. Today is ${new Date().toISOString()}.`,
      handle.id,
    );
    transcript.push({ role: "strategist", ...plan });

    await reportProgress(handle, "writing", "Drafting posts and sending them for review", "copywriter");
    const copy = await runRole(
      options,
      "copywriter",
      `${context}\n\n## This week's plan\n\n${plan.text}\n\nWrite and propose each post. Today is ${new Date().toISOString()}.`,
      handle.id,
    );
    transcript.push({ role: "copywriter", ...copy });

    const after = await countProposals(db, workspaceId);
    await finishRun(db, handle, { transcript });

    return {
      runId: handle.id,
      briefing: research.text,
      plan: plan.text,
      proposals: after - before,
    };
  } catch (error) {
    await finishRun(db, handle, { transcript, error: (error as Error).message });
    throw error;
  }
}

async function countProposals(db: Database, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.posts.id })
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        eq(schema.posts.status, "pending_approval"),
      ),
    );
  return rows.length;
}

export type TriageResult = {
  runId: string;
  handled: number;
  skipped?: string;
};

/** Triages new replies and mentions, drafting responses or recommending silence. */
export async function runReplyTriage(options: RunOptions): Promise<TriageResult> {
  const { db, workspaceId } = options;

  const pending = await db
    .select()
    .from(schema.inboundItems)
    .where(
      and(
        eq(schema.inboundItems.workspaceId, workspaceId),
        eq(schema.inboundItems.status, "new"),
      ),
    )
    .limit(15);

  if (pending.length === 0) return { runId: "", handled: 0 };
  if (!hasModelAccess()) {
    return { runId: "", handled: 0, skipped: new NoModelConfiguredError().message };
  }

  const handle = await startRun(db, {
    workspaceId,
    trigger: "event_reply",
    role: "community",
    publisher: options.publisher,
    model: options.model,
  });

  try {
    const listing = pending
      .map(
        (item) =>
          `- id=${item.id} from @${item.authorHandle} (${item.sentiment ?? "unclassified"}): ${item.text}`,
      )
      .join("\n");

    const context = await memory.buildContext(db, workspaceId);
    await reportProgress(handle, "triaging", `${pending.length} new comments`, "community");

    const result = await runRole(
      options,
      "community",
      `${context}\n\n## New comments\n\n${listing}\n\nTriage each one: draft a reply or recommend ignoring it. Read the full item first when the excerpt is not enough.`,
      handle.id,
    );

    await finishRun(db, handle, { transcript: result.transcript });
    return { runId: handle.id, handled: pending.length };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}

export type AnalysisResult = {
  runId: string;
  report: string;
  skipped?: string;
};

/** Nightly review; also produces the weekly report when asked. */
export async function runAnalysis(
  options: RunOptions & { weekly?: boolean },
): Promise<AnalysisResult> {
  const { db, workspaceId } = options;

  if (!hasModelAccess()) {
    return { runId: "", report: "", skipped: new NoModelConfiguredError().message };
  }

  const handle = await startRun(db, {
    workspaceId,
    trigger: "cron_analyze",
    role: "analyst",
    publisher: options.publisher,
    model: options.model,
  });

  try {
    const context = await memory.buildContext(db, workspaceId);
    await reportProgress(handle, "analysing", "Reviewing recent performance", "analyst");

    const task = options.weekly
      ? "Write this week's report: what went out, how it did, what you learned, what you plan next, and anything you need a decision on. Then update the learnings and, if the evidence supports it, the strategy."
      : "Review the last few days. Update the learnings document if you found something that holds up.";

    const result = await runRole(options, "analyst", `${context}\n\n${task}`, handle.id);

    // A weekly report nobody can find is not a report. Store it as a versioned
    // memory doc so the dashboard can show the latest one.
    if (options.weekly && result.text.trim()) {
      await memory.writeMemory(db, {
        workspaceId,
        kind: "report",
        contentMd: result.text,
        actor: agentActor(handle.id, "analyst"),
      });
    }

    await finishRun(db, handle, { transcript: result.transcript });
    return { runId: handle.id, report: result.text };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}

/**
 * A chat turn. Same tools and the same autonomy guard as the scheduled runs —
 * asking for a draft here still produces a proposal, not a live post.
 *
 * Prior turns are passed in so follow-ups work ("make that shorter" needs to
 * know what "that" was), and the tools that ran come back out so the UI can
 * show its work rather than an unexplained answer.
 */
export async function runChat(
  options: RunOptions & {
    message: string;
    accountId?: string;
    trigger?: TriggerName;
    history?: string;
  },
): Promise<{
  runId: string;
  reply: string;
  toolCalls: { tool: string; summary?: string }[];
}> {
  const { db, workspaceId } = options;

  if (!hasModelAccess()) throw new NoModelConfiguredError();

  const handle = await startRun(db, {
    workspaceId,
    trigger: options.trigger ?? "chat",
    role: "assistant",
    publisher: options.publisher,
    model: options.model,
  });

  try {
    const context = await memory.buildContext(db, workspaceId, options.accountId);
    const conversation = options.history
      ? `\n\n## Conversation so far\n\n${options.history}`
      : "";

    const result = await runRole(
      options,
      "assistant",
      `${context}${conversation}\n\n## Message from the operator\n\n${options.message}`,
      handle.id,
    );

    await finishRun(db, handle, { transcript: result.transcript });
    return {
      runId: handle.id,
      reply: result.text,
      toolCalls: toolCallsFrom(result.transcript),
    };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}


/** Flattens a transcript into the list of tools that actually ran. */
function toolCallsFrom(transcript: unknown[]): { tool: string; summary?: string }[] {
  const calls: { tool: string; summary?: string }[] = [];
  for (const step of transcript) {
    const s = step as { toolCalls?: { tool?: string }[] };
    for (const call of s.toolCalls ?? []) {
      if (call.tool) calls.push({ tool: call.tool });
    }
  }
  return calls;
}
