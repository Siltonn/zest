import { RequestContext } from "@mastra/core/request-context";
import type { Database } from "@zest/db";
import type { Actor } from "@zest/shared";
import type { EventPublisher } from "@zest/core";

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
};

const KEY = "zest";

export function buildRequestContext(context: ToolContext): RequestContext {
  const request = new RequestContext();
  request.set(KEY, context);
  return request;
}

/**
 * Failing loudly here beats a tool silently writing to the wrong workspace, so
 * a missing context is an error rather than a default.
 */
export function readToolContext(request: unknown): ToolContext {
  const context = (request as RequestContext | undefined)?.get?.(KEY) as
    | ToolContext
    | undefined;
  if (!context) {
    throw new Error(
      "Zest tool context is missing — agents must be started through the workflow helpers",
    );
  }
  return context;
}
