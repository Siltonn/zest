import { PgVector } from "@mastra/pg";
import { closeDatabase, createDatabase, sql } from "@zest/db";
import { attachRecall } from "./agents/assistant/memory.ts";
import { resolveEmbedder } from "./models.ts";

/**
 * Boot-time wiring for the assistant's semantic recall.
 *
 * Recall has two hard prerequisites the agent definition cannot check for
 * itself: an embedding provider (Anthropic alone has none) and the pgvector
 * extension (the stock postgres image ships without it). Both are probed here,
 * once, when a runtime starts — including one real embedding call, because a
 * key that exists is not a key that works: OpenRouter, for instance, accepts
 * `openai/*` chat models but refuses the same vendor's embedding models.
 *
 * Failing any probe never breaks boot. The assistant's Memory simply keeps no
 * vector store attached, every recall path inside it skips quietly, and chat
 * runs exactly as it did before recall existed. The status says which of the
 * two answers the operator got, and why.
 */

export type RecallStatus =
  | { enabled: true; model: string }
  | { enabled: false; reason: string };

let status: RecallStatus = {
  enabled: false,
  reason: "recall wiring has not run in this process",
};

/** What the current process decided at boot — for /me and the logs. */
export function recallStatus(): RecallStatus {
  return status;
}

export async function enableAssistantRecall(
  connectionString: string,
): Promise<RecallStatus> {
  const embedder = resolveEmbedder();
  if (!embedder) {
    return (status = {
      enabled: false,
      reason:
        "no embedding provider — semantic recall needs OPENROUTER_API_KEY or OPENAI_API_KEY",
    });
  }

  // The extension, not the image name, is what matters: `CREATE EXTENSION` is
  // idempotent and needs the same privileges PgVector would need later, so a
  // failure here is exactly the failure chat turns would have hit.
  const db = createDatabase(connectionString, { max: 1 });
  try {
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS vector"));
  } catch (error) {
    return (status = {
      enabled: false,
      reason: `pgvector is not available in this Postgres (${(error as Error).message.trim()}) — the compose file's pgvector/pgvector image ships it`,
    });
  } finally {
    await closeDatabase(db);
  }

  // One real embedding, so a broken key, a refused model, or an embedder too
  // wide for pgvector's 2000-dimension index limit is a boot log line instead
  // of a failed chat turn.
  try {
    const probe = await embedder.model.doEmbed({
      values: ["zest"],
      ...embedder.options,
    });
    const dimensions = probe.embeddings[0]?.length ?? 0;
    if (dimensions === 0 || dimensions > 2000) {
      return (status = {
        enabled: false,
        reason: `embedding model ${embedder.id} returned ${dimensions} dimensions — recall needs 1..2000 to be indexable`,
      });
    }
  } catch (error) {
    return (status = {
      enabled: false,
      reason: `embedding model ${embedder.id} failed its probe: ${(error as Error).message.trim()}`,
    });
  }

  attachRecall({
    // The same `mastra` schema as the message store, so the documented reset —
    // DROP SCHEMA mastra CASCADE — still clears conversations and their
    // embeddings together.
    vector: new PgVector({
      id: "zest-recall",
      connectionString,
      schemaName: "mastra",
      max: 3,
    }),
    embedder,
  });

  return (status = { enabled: true, model: embedder.id });
}
