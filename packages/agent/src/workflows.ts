import { generateText } from "ai";
import { schema, eq, and, inArray, type Database } from "@zest/db";
import { memory, plans, transition } from "@zest/core";
import type { EventPublisher } from "@zest/core";
import { agent as agentActor } from "@zest/shared";
import { createRoleAgent, type RoleName } from "./agents.ts";
import { buildRequestContext } from "./context.ts";
import {
  NoModelConfiguredError,
  hasModelAccess,
  resolveModel,
  resolvedModelId,
} from "./models.ts";
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

/**
 * `scope` carries the plan and account a stage is bound to.
 *
 * These have to reach the tool context or `add_plan_items` cannot tell which
 * programme it is writing for, and refuses every call with "this run is not
 * attached to a plan" — which the model then retries and the stage still
 * reports success, having produced nothing.
 */
async function runRole(
  options: RunOptions,
  role: RoleName,
  prompt: string,
  runId: string,
  scope: { planId?: string; accountId?: string } = {},
): Promise<RoleResult> {
  const agent = createRoleAgent(role, options.model);
  const result = await agent.generate(prompt, {
    requestContext: buildRequestContext({
      db: options.db,
      workspaceId: options.workspaceId,
      actor: agentActor(runId, role),
      runId,
      publisher: options.publisher,
      ...scope,
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
    const result = await runRole(options, "strategist", brief, handle.id, { planId });
    const after = await plans.readPlan(db, workspaceId, planId);

    const added = (after?.items.length ?? before) - before;

    // A strategist that returns prose and no items has failed, however
    // articulate the prose was: the copywriter fan-out reads rows, so the cycle
    // ends here with nothing to show and no reason recorded. Say so on the run.
    if (added === 0) {
      const reason =
        "The strategist finished without recording any plan items — nothing to write.";
      await finishRun(db, handle, {
        transcript: result.transcript,
        output: result.text,
        error: reason,
      });
      return { runId: handle.id, plan: result.text, items: 0, skipped: reason };
    }

    await finishRun(db, handle, {
      transcript: result.transcript,
      output: result.text,
    });
    return { runId: handle.id, plan: result.text, items: added };
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
    const result = await runRole(options, "copywriter", brief, handle.id, {
      planId,
      accountId,
    });
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

  if (!hasModelAccess()) {
    return { runId: "", handled: 0, skipped: new NoModelConfiguredError().message };
  }

  /**
   * Claim the comments before drafting anything.
   *
   * Triage fires from two places — the ingest processor when new comments
   * arrive, and the operator pressing the button — so two runs overlap easily.
   * Reading the `new` rows and marking them later meant both runs saw the same
   * comments and both drafted: measured, every one of seven comments came back
   * with two replies waiting in the inbox.
   *
   * The same conditional UPDATE the publisher uses to claim a due post: the
   * status flip is the claim, and a losing run gets an empty set and stops. In
   * the database, not the queue, for the same reason as publishing.
   */
  const pending = await db
    .update(schema.inboundItems)
    .set({ status: "triaged" })
    .where(
      and(
        eq(schema.inboundItems.workspaceId, workspaceId),
        eq(schema.inboundItems.status, "new"),
        inArray(
          schema.inboundItems.id,
          db
            .select({ id: schema.inboundItems.id })
            .from(schema.inboundItems)
            .where(
              and(
                eq(schema.inboundItems.workspaceId, workspaceId),
                eq(schema.inboundItems.status, "new"),
              ),
            )
            .limit(15),
        ),
      ),
    )
    .returning();

  if (pending.length === 0) return { runId: "", handled: 0 };

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
    // Give the claim back. A crashed run holding six comments in `triaged`
    // with nothing drafted is worse than a duplicate: they stop showing as
    // unanswered and nobody ever sees them again.
    await db
      .update(schema.inboundItems)
      .set({ status: "new" })
      .where(
        and(
          inArray(
            schema.inboundItems.id,
            pending.map((item) => item.id),
          ),
          eq(schema.inboundItems.status, "triaged"),
        ),
      );

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

    // The report is filed by the analyst through `write_report`, not scraped
    // from the run's text: `result.text` concatenates every step, so saving it
    // put "I'll review the recent performance… Let me start by gathering the
    // analytics" at the top of the operator's weekly report.
    if (options.weekly) {
      const filed = await memory.readMemory(db, workspaceId, "report");
      if (!filed) {
        await finishRun(db, handle, {
          transcript: result.transcript,
          output: result.text,
          error: "The analyst finished without filing a report.",
        });
        return {
          runId: handle.id,
          report: "",
          skipped: "The analyst finished without filing a report.",
        };
      }
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

    const result = await runRole(options, "copywriter", brief, handle.id, {
      accountId: row.account.id,
    });
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

export type PolishResult = {
  runId: string;
  text: string;
  skipped?: string;
};

/**
 * Polishing a hand-written draft against an account's voice card.
 *
 * The composer was the one agent-free surface in the product — the comparison
 * with Postiz made that embarrassing, since even the scheduler-first competitor
 * embeds a copilot in its editor. Ours is narrower on purpose: not "generate a
 * post about X" but "take what the operator wrote and make it sound like this
 * account", which is the half generation tools get wrong.
 *
 * Plain `generateText` rather than the tool-carrying copywriter agent: this is
 * an inline request someone is sitting on, and a text transform has no business
 * proposing posts as a side effect.
 */
export async function polishDraft(
  options: RunOptions & { accountId: string; text: string },
): Promise<PolishResult> {
  const { db, workspaceId, accountId } = options;

  if (!hasModelAccess()) {
    return { runId: "", text: options.text, skipped: new NoModelConfiguredError().message };
  }

  const [account] = await db
    .select()
    .from(schema.linkedAccounts)
    .where(eq(schema.linkedAccounts.id, accountId));
  if (!account) return { runId: "", text: options.text, skipped: "Unknown account" };

  const handle = await startRun(db, {
    workspaceId,
    trigger: "manual",
    role: "copywriter",
    accountId,
    publisher: options.publisher,
    model: resolvedModelId(options.model),
  });

  try {
    const context = await memory.buildContext(db, workspaceId, accountId);

    const { text } = await generateText({
      model: resolveModel(options.model),
      prompt: [
        context,
        `The operator drafted this for @${account.handle}:`,
        options.text,
        "Polish it: keep their point and their facts, tighten the wording, and make",
        "it match this account's voice card. Do not add claims, hashtags, or emoji",
        "they did not write. If it already reads well, change less rather than more.",
        "Reply with the post text only — no preamble, no quotes around it.",
      ].join("\n\n"),
    });

    const polished = text.trim();
    if (!polished) {
      await finishRun(db, handle, { error: "The polish came back empty" });
      return { runId: handle.id, text: options.text, skipped: "The polish came back empty" };
    }

    await finishRun(db, handle, {
      transcript: [{ text: polished, finishReason: "stop" }],
      output: polished,
    });
    return { runId: handle.id, text: polished };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}
