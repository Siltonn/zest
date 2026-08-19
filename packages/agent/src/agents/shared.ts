import type { Agent } from "@mastra/core/agent";
import { memory } from "@zest/core";
import type { Database } from "@zest/db";
import type { EventPublisher } from "@zest/core";
import { agent as agentActor } from "@zest/shared";
import {
  buildRequestContext,
  maybeToolContext,
} from "../context.ts";
import {
  injectedModel,
  resolveModel,
  type ModelOverride,
} from "../models.ts";
import { toTranscript } from "../runs.ts";

/**
 * What is genuinely shared between the agents: types, the voice rules three of
 * them quote, and three mechanical helpers. Prompt assembly — which context
 * blocks an agent reads, and how its instructions are put together — is *not*
 * here on purpose. That is each agent's most important decision, and it lives
 * in that agent's own file where it can be seen and can diverge.
 */

export type RoleName =
  | "researcher"
  | "strategist"
  | "copywriter"
  | "community"
  | "analyst"
  | "assistant";

/** What every stage entry point takes; `model` also accepts a test-injected object. */
export type RunOptions = {
  db: Database;
  workspaceId: string;
  publisher?: EventPublisher;
  model?: ModelOverride;
};

export type RoleResult = {
  text: string;
  transcript: unknown[];
  /**
   * Messages this turn added (memory history excluded) — the persisted ids the
   * chat path needs to annotate its assistant message. Empty when the agent
   * has no memory in play.
   */
  responseMessages: { id: string; role: string }[];
};

export const SHARED_VOICE_RULES = `
Rules that apply to everything you write:
- Write the post itself. No preamble, no "Here's a post:", no markdown headings.
- Match the voice in the account's playbook exactly. If two accounts cover the
  same topic,
  they must sound like different people, not the same text reworded.
- Never invent metrics, customers, launches, or quotes. If you need a fact you
  do not have, write around it or ask.
- No hashtag stuffing. At most two, and only if they are how that community
  actually tags things.
- Respect the platform's character limit — check it, do not guess.
`.trim();

/**
 * The workspace memory block for an agent's system prompt, resolved from the
 * request context the run carries. Returns "" when there is no context to read
 * (Studio's agent listing resolves instructions with none), so each agent can
 * decide what its bare prompt looks like.
 *
 * `accountVoice` opts into the account's playbook and its account-scoped
 * learnings, keyed by the run's pinned accountId — the copywriter wants them,
 * the researcher has no business reading either.
 */
export async function brandContext(
  requestContext: unknown,
  opts: { accountVoice?: boolean } = {},
): Promise<string> {
  const context = maybeToolContext(requestContext);
  if (!context) return "";
  return memory.buildContext(
    context.db,
    context.workspaceId,
    opts.accountVoice ? context.accountId : undefined,
  );
}

/**
 * Per-request model resolution, shared verbatim by every agent: a test-injected
 * object passes through, a string (or nothing) goes to the provider chain.
 * A function rather than a value so importing an agent module never touches
 * `resolveModel` — the server boots keyless, and so do the tests.
 */
export function dynamicModel({
  requestContext,
}: {
  requestContext: unknown;
}): ReturnType<typeof resolveModel> {
  const override = maybeToolContext(requestContext)?.model;
  if (injectedModel(override)) return override;
  return resolveModel(override);
}

/**
 * One agent turn with the run's tool context — today's `runRole`, minus the
 * context prefix (that moved into each agent's instructions) and minus the
 * per-run agent construction (the agents are singletons now).
 *
 * Three pieces of bookkeeping, and deliberately nothing else:
 * 1. The per-run ToolContext, built once so the actor and `runId` cannot drift
 *    apart — they are how every write is attributed, and seven call sites
 *    assembling them by hand would eventually disagree. `planId`/`accountId`
 *    must reach the tools or `add_plan_items` refuses every call.
 * 2. `maxSteps` pinned in one place.
 * 3. The result normalised into the transcript shape the run row stores —
 *    `toTranscript` has already been broken once by an SDK shape change, so
 *    there is exactly one caller to fix next time.
 *
 * What the stage decides at the call site: the agent, the prompt, the scope.
 */
export async function generateStage(
  agent: Agent,
  prompt: string,
  options: RunOptions & {
    runId: string;
    role: RoleName;
    planId?: string;
    accountId?: string;
    /** Chat threads only: load and persist under this conversation. */
    memory?: { thread: string | { id: string }; resource: string };
  },
): Promise<RoleResult> {
  const result = await agent.generate(prompt, {
    requestContext: buildRequestContext({
      db: options.db,
      workspaceId: options.workspaceId,
      actor: agentActor(options.runId, options.role),
      runId: options.runId,
      publisher: options.publisher,
      model: options.model,
      planId: options.planId,
      accountId: options.accountId,
    }),
    memory: options.memory,
    maxSteps: 18,
  });

  const remembered = new Set(
    (result.rememberedMessages ?? []).map((message) => message.id),
  );

  return {
    text: result.text ?? "",
    transcript: toTranscript((result as { steps?: unknown }).steps),
    responseMessages: (result.messages ?? [])
      .filter((message) => !remembered.has(message.id))
      .map((message) => ({ id: message.id, role: message.role })),
  };
}
