import { schema, eq, and, inArray, type Database } from "@zest/db";
import { memory, plans, transition } from "@zest/core";
import type { EventPublisher } from "@zest/core";
import { agent as agentActor } from "@zest/shared";
import { createRoleAgent, type RoleName } from "./agents.ts";
import { buildRequestContext } from "./context.ts";
import { NoModelConfiguredError, hasModelAccess, resolvedModelId } from "./models.ts";
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

export type ResearchResult = {
  runId: string;
  briefing: string;
  skipped?: string;
};

export type StrategyResult = {
  runId: string;
  plan: string;
  items: number;
  skipped?: string;
};

export type CopyResult = {
  runId: string;
  proposals: number;
  skipped?: string;
};

/**
 * Stage one: what is worth talking about.
 *
 * Deliberately workspace-wide and run once per cycle. Trends and performance
 * are shared across accounts, so researching per account would spend N times
 * the tokens on near-identical output — and worse, would stop the accounts
 * coordinating, which is the whole reason a brand account and a founder account
 * live in one workspace.
 */
export async function runResearch(options: RunOptions): Promise<ResearchResult> {
  const { db, workspaceId } = options;

  if (!hasModelAccess()) {
    return { runId: "", briefing: "", skipped: new NoModelConfiguredError().message };
  }

  const handle = await startRun(db, {
    workspaceId,
    trigger: "cron_plan",
    role: "researcher",
    publisher: options.publisher,
    model: resolvedModelId(options.model),
  });

  // The cycle is named after the run that starts it, so every later stage can
  // point back without a separate table.
  await db
    .update(schema.agentRuns)
    .set({ cycleId: handle.id })
    .where(eq(schema.agentRuns.id, handle.id));

  try {
    const context = await memory.buildContext(db, workspaceId);
    await reportProgress(handle, "researching", "Looking at trends and recent performance", "researcher");

    const research = await runRole(
      options,
      "researcher",
      `${context}\n\nResearch what this brand should post about this week.`,
      handle.id,
    );

    await finishRun(db, handle, {
      transcript: research.transcript,
      output: research.text,
    });
    return { runId: handle.id, briefing: research.text };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}

/**
 * Stage two: what this programme will post, as rows.
 *
 * Runs once per plan, so a launch week and an always-on programme each get
 * their own strategist pass over the same briefing. The output is plan items,
 * not prose — which is what makes it reviewable before anything is written.
 */
export async function runStrategy(
  options: RunOptions & { planId: string; briefing: string; cycleId?: string },
): Promise<StrategyResult> {
  const { db, workspaceId, planId } = options;

  if (!hasModelAccess()) {
    return { runId: "", plan: "", items: 0, skipped: new NoModelConfiguredError().message };
  }

  const found = await plans.readPlan(db, workspaceId, planId);
  if (!found) return { runId: "", plan: "", items: 0, skipped: "No such plan" };
  if (found.accountIds.length === 0) {
    return { runId: "", plan: "", items: 0, skipped: `"${found.plan.name}" has no accounts` };
  }

  const handle = await startRun(db, {
    workspaceId,
    trigger: "cron_plan",
    role: "strategist",
    planId,
    cycleId: options.cycleId ?? null,
    publisher: options.publisher,
    model: resolvedModelId(options.model),
  });

  try {
    const context = await memory.buildContext(db, workspaceId);
    await reportProgress(handle, "planning", `Planning "${found.plan.name}"`, "strategist");

    const accounts = await db
      .select({
        id: schema.linkedAccounts.id,
        handle: schema.linkedAccounts.handle,
        connectorId: schema.linkedAccounts.connectorId,
      })
      .from(schema.linkedAccounts)
      .where(inArray(schema.linkedAccounts.id, found.accountIds));

    const window = [
      found.plan.startsAt ? `starts ${found.plan.startsAt.toISOString()}` : null,
      found.plan.endsAt ? `ends ${found.plan.endsAt.toISOString()}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    const brief = [
      context,
      `## Research briefing\n\n${options.briefing}`,
      `## Programme: ${found.plan.name}`,
      found.plan.objective ? `Objective: ${found.plan.objective}` : null,
      `Cadence: ${found.plan.schedule}${window ? ` (${window})` : ""}`,
      `Accounts this programme writes for:\n${accounts
        .map((a) => `- ${a.id} — @${a.handle} on ${a.connectorId}`)
        .join("\n")}`,
      `Today is ${new Date().toISOString()}.`,
      "Call add_plan_items once with the whole plan. Use only the account ids listed above.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const before = found.items.length;
    const result = await runRole(options, "strategist", brief, handle.id);
    const after = await plans.readPlan(db, workspaceId, planId);

    await finishRun(db, handle, {
      transcript: result.transcript,
      output: result.text,
    });
    return {
      runId: handle.id,
      plan: result.text,
      items: (after?.items.length ?? before) - before,
    };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}

/**
 * Stage three: the writing, one account at a time.
 *
 * Scoped to a single account on purpose. The copywriter used to be handed every
 * account in one context and asked to switch voice between items, which is how
 * a founder account starts sounding like a press release. One run per voice
 * costs a little more and keeps them apart.
 */
export async function runCopy(
  options: RunOptions & { planId: string; accountId: string; cycleId?: string },
): Promise<CopyResult> {
  const { db, workspaceId, planId, accountId } = options;

  if (!hasModelAccess()) {
    return { runId: "", proposals: 0, skipped: new NoModelConfiguredError().message };
  }

  const items = await plans.pendingItems(db, planId, accountId);
  if (items.length === 0) return { runId: "", proposals: 0, skipped: "Nothing left to write" };

  const [account] = await db
    .select()
    .from(schema.linkedAccounts)
    .where(eq(schema.linkedAccounts.id, accountId));
  if (!account) return { runId: "", proposals: 0, skipped: "Unknown account" };

  const handle = await startRun(db, {
    workspaceId,
    trigger: "cron_plan",
    role: "copywriter",
    planId,
    accountId,
    cycleId: options.cycleId ?? null,
    publisher: options.publisher,
    model: resolvedModelId(options.model),
  });

  try {
    const context = await memory.buildContext(db, workspaceId, accountId);
    await reportProgress(handle, "writing", `Writing for @${account.handle}`, "copywriter");

    const brief = [
      context,
      `You are writing for account ${account.id} (@${account.handle}) and no other.`,
      `## Your assignments\n\n${items
        .map(
          (item) =>
            `- planItemId ${item.id} — ${item.topic}${item.angle ? ` — angle: ${item.angle}` : ""}${
              item.suggestedSlotAt ? ` — slot: ${item.suggestedSlotAt.toISOString()}` : ""
            }`,
        )
        .join("\n")}`,
      "Write and propose each one, passing its planItemId so the plan knows it is done.",
      `Today is ${new Date().toISOString()}.`,
    ].join("\n\n");

    const before = await countProposals(db, workspaceId);
    const result = await runRole(options, "copywriter", brief, handle.id);
    const after = await countProposals(db, workspaceId);

    await finishRun(db, handle, {
      transcript: result.transcript,
      output: result.text,
    });
    return { runId: handle.id, proposals: after - before };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
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
    model: resolvedModelId(options.model),
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
    model: resolvedModelId(options.model),
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
    model: resolvedModelId(options.model),
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

export type ReworkResult = {
  runId: string;
  revised: boolean;
  skipped?: string;
};

/**
 * Rewriting a post that was sent back with a note.
 *
 * This is what makes "ask for changes" different from "reject": the operator
 * says what is wrong once, in their own words, and the draft comes back
 * addressed rather than being retyped by hand. Without it `needs_changes` is a
 * dead end that the inbox keeps showing you.
 *
 * The copywriter does it, scoped to the one account, so the revision is bound by
 * the same voice card as the original.
 */
export async function runRework(
  options: RunOptions & { postId: string },
): Promise<ReworkResult> {
  const { db, workspaceId, postId } = options;

  if (!hasModelAccess()) {
    return { runId: "", revised: false, skipped: new NoModelConfiguredError().message };
  }

  const [row] = await db
    .select({ post: schema.posts, account: schema.linkedAccounts })
    .from(schema.posts)
    .innerJoin(
      schema.linkedAccounts,
      eq(schema.posts.accountId, schema.linkedAccounts.id),
    )
    .where(
      and(eq(schema.posts.id, postId), eq(schema.posts.workspaceId, workspaceId)),
    );
  if (!row) return { runId: "", revised: false, skipped: "No such post" };

  // The note lives in errorMessage — the same field a failed publish uses,
  // because both answer "why is this back in front of you".
  const feedback = row.post.errorMessage;
  if (row.post.status !== "needs_changes" || !feedback) {
    return { runId: "", revised: false, skipped: "That post is not awaiting a rewrite" };
  }

  const handle = await startRun(db, {
    workspaceId,
    trigger: "manual",
    role: "copywriter",
    accountId: row.account.id,
    publisher: options.publisher,
    model: resolvedModelId(options.model),
  });

  try {
    const context = await memory.buildContext(db, workspaceId, row.account.id);
    await reportProgress(
      handle,
      "rewriting",
      `Revising for @${row.account.handle}`,
      "copywriter",
    );

    const brief = [
      context,
      `You are revising an existing post for @${row.account.handle}, and nothing else.`,
      `## The draft as it stands\n\n${row.post.content.text}`,
      `## What the operator asked for\n\n${feedback}`,
      "Rewrite it to address that note. Change what was asked and leave the rest alone —",
      "this is a revision, not a fresh attempt. Reply with the new post text only:",
      "no preamble, no explanation, no quotes around it.",
    ].join("\n\n");

    const result = await runRole(options, "copywriter", brief, handle.id);
    const revised = result.text.trim();

    if (!revised) {
      await finishRun(db, handle, {
        transcript: result.transcript,
        error: "The rewrite came back empty",
      });
      return { runId: handle.id, revised: false, skipped: "The rewrite came back empty" };
    }

    // Straight back to pending_approval: a revision the operator has not seen is
    // still a proposal, and clearing the note stops it reading as unaddressed.
    await transition(db, {
      postId,
      action: "edit",
      actor: agentActor(handle.id, "copywriter"),
      agentRunId: handle.id,
      patch: {
        content: { ...row.post.content, text: revised },
        errorMessage: null,
      },
    });

    await finishRun(db, handle, { transcript: result.transcript, output: revised });
    return { runId: handle.id, revised: true };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}
