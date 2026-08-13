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
  z.object({ kind: z.literal("mcp"), clientId: z.string() }),
  z.object({ kind: z.literal("api"), keyId: z.string() }),
]);

export type Actor = z.infer<typeof actorSchema>;

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
