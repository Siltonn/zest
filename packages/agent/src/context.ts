import { RequestContext } from "@mastra/core/request-context";
import type { Database } from "@zest/db";
import type { Actor } from "@zest/shared";
import type { EventPublisher } from "@zest/core";
import type { ModelOverride } from "./models.ts";

/**
 * Everything a tool needs to do its job, carried on Mastra's per-request
 * context. Tools call domain services in `@zest/core` directly — they are not a
 * second implementation of the business rules, just a typed surface onto them.
 */
export type ToolContext = {
  db: Database;
  workspaceId: string;
  /** Identifies the run so every write is attributable to it in the audit log. */
  actor: Actor;
  runId: string;
  publisher?: EventPublisher;
  /** Set on plan stages, so a tool writes into the programme that invoked it. */
  planId?: string;
  /** Set on the copywriter stage, which is scoped to one account. */
  accountId?: string;
  /**
   * Model override for this run: an id string, or a LanguageModel object a
   * test injected. On the request context rather than in any input payload
   * because an object cannot ride through a JSON schema.
   */
  model?: ModelOverride;
};

/**
 * What exists before a run row does.
 *
 * The plan-cycle workflow's steps need the database and workspace to call a
 * stage function, but `actor` and `runId` are minted by `startRun` inside that
 * stage — so the workflow carries this narrower slice on the same key, and
 * `readToolContext` keeps demanding the full shape a tool needs.
 */
export type StageContext = Pick<
  ToolContext,
  "db" | "workspaceId" | "publisher" | "model"
>;

const KEY = "zest";

export function buildRequestContext(context: ToolContext): RequestContext {
  const request = new RequestContext();
  setToolContext(request, context);
  return request;
}

export function buildStageContext(context: StageContext): RequestContext {
  const request = new RequestContext();
  request.set(KEY, context);
  return request;
}

/**
 * The same write, onto a context somebody else made.
 *
 * Mastra's HTTP server builds the request context itself, before any middleware
 * runs, so the Studio path cannot use `buildRequestContext` — it has to add to
 * what is already there or lose whatever the caller sent. Exported so that path
 * does not have to know the key.
 */
export function setToolContext(
  request: RequestContext,
  context: ToolContext,
): void {
  request.set(KEY, context);
}

/**
 * Failing loudly here beats a tool silently writing to the wrong workspace, so
 * a missing context is an error rather than a default.
 */
export function readToolContext(request: unknown): ToolContext {
  const context = maybeToolContext(request);
  if (!context || !context.actor || !context.runId) {
    throw new Error(
      "Zest tool context is missing — agents must be started through the workflow helpers",
    );
  }
  return context as ToolContext;
}

/** The stage slice, for workflow steps that run before any run row exists. */
export function readStageContext(request: unknown): StageContext {
  const context = maybeToolContext(request);
  if (!context?.db || !context.workspaceId) {
    throw new Error(
      "Zest stage context is missing — workflows must be started through runPlanCycle or Studio",
    );
  }
  return context;
}

/**
 * The tolerant reader, for places that degrade rather than fail: an agent's
 * dynamic instructions resolve on requests that carry no context at all
 * (Studio's agent listing), and the right answer there is the bare prompt.
 *
 * Checked structurally, not just for presence. Studio's agent-detail route
 * hands dynamic instructions a proxied context whose `get` returns the
 * placeholder string `"<zest>"` for missing keys — that is how its UI shows
 * `<key>` slots in a dynamic prompt — and anything can be typed into its
 * request-context panel besides. Neither is a tool context, however truthy;
 * treating them as one crashed the agent page on `undefined.select`.
 */
export function maybeToolContext(
  request: unknown,
): (Partial<ToolContext> & StageContext) | undefined {
  const value = (request as RequestContext | undefined)?.get?.(KEY);
  if (!value || typeof value !== "object") return undefined;
  const context = value as Partial<ToolContext>;
  if (!context.db || !context.workspaceId) return undefined;
  return context as Partial<ToolContext> & StageContext;
}
