import { z } from "zod";

/**
 * Every state transition records who caused it. Provenance is a product
 * feature, not a log line: the audit view answers "did a human approve this,
 * or did an autonomy rule let the agent act on its own?"
 */
export const actorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), userId: z.string() }),
  z.object({ kind: z.literal("agent"), runId: z.string(), role: z.string().optional() }),
  z.object({ kind: z.literal("system"), source: z.string() }),
  z.object({
    kind: z.literal("mcp"),
    clientId: z.string(),
    /**
     * Present when the MCP session was authorized by a signed-in user (OAuth)
     * rather than a bare API key. Decisions that escalate what the agent may do
     * on its own — granting autonomy — require this: a machine credential must
     * not be able to widen its own leash.
     */
    userId: z.string().optional(),
  }),
  z.object({ kind: z.literal("api"), keyId: z.string() }),
]);

export type Actor = z.infer<typeof actorSchema>;

/**
 * Whether a person stands behind this actor. Humans do by definition; an MCP
 * client does when its token came from a user-authorized OAuth flow. Agents,
 * API keys and system actors do not — they are standing credentials, and some
 * decisions (granting the agent autonomy) must trace to a person.
 */
export function isUserBacked(
  actor: Actor,
): actor is Extract<Actor, { kind: "human" }> | (Extract<Actor, { kind: "mcp" }> & { userId: string }) {
  if (actor.kind === "human") return true;
  return actor.kind === "mcp" && typeof actor.userId === "string" && actor.userId.length > 0;
}

/** The user behind the actor, when one exists. */
export function actorUserId(actor: Actor): string | null {
  if (actor.kind === "human") return actor.userId;
  if (actor.kind === "mcp" && actor.userId) return actor.userId;
  return null;
}

export const human = (userId: string): Actor => ({ kind: "human", userId });
export const agent = (runId: string, role?: string): Actor => ({
  kind: "agent",
  runId,
  ...(role ? { role } : {}),
});
export const system = (source: string): Actor => ({ kind: "system", source });

export function describeActor(actor: Actor): string {
  switch (actor.kind) {
    case "human":
      return `human:${actor.userId}`;
    case "agent":
      return actor.role ? `agent:${actor.role}:${actor.runId}` : `agent:${actor.runId}`;
    case "system":
      return `system:${actor.source}`;
    case "mcp":
      return `mcp:${actor.clientId}`;
    case "api":
      return `api:${actor.keyId}`;
  }
}
