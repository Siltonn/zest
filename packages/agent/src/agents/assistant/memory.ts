import { Memory } from "@mastra/memory";
import type { MastraVector } from "@mastra/core/vector";
import { resolveCheapModel, type ResolvedEmbedder } from "../../models.ts";

/**
 * The assistant's memory, in two shapes.
 *
 * Mastra validates `semanticRecall` in the Memory constructor — naming it
 * without a vector store throws on import, and the vector store cannot exist
 * until a runtime knows its database. So the base shape (working memory,
 * recent history, titles) is built immediately, and `attachRecall` rebuilds
 * with the vector store, embedder and recall options once boot has proved all
 * three work. The agent takes `assistantMemory` — the resolver, not an
 * instance — so every turn uses whichever shape the process has earned.
 */

/**
 * The notepad's shape. Headings keep the model from writing an essay; the
 * parenthetical hints say what belongs where — and the template is also what
 * the operator sees in the chat panel's "assistant notes" view, so it reads
 * as a document, not a dump.
 */
const WORKING_MEMORY_TEMPLATE = `
# Operator notes

## Working with the operator
- (Name, role, language, how they like answers — length, tone, data-first?)

## Standing instructions
- (Rules to honor in every conversation, e.g. "show numbers before drafting")

## Current focus
- (What we are working toward right now, with dates when they matter)

## Open loops
- (Waiting on a decision, a draft to revisit, a question to answer later)
`.trim();

type RecallInfra = { vector: MastraVector; embedder: ResolvedEmbedder };

function buildMemory(recall?: RecallInfra): Memory {
  return new Memory({
    ...(recall
      ? {
          vector: recall.vector,
          embedder: recall.embedder.model,
          embedderOptions: recall.embedder.options,
        }
      : {}),
    options: {
      lastMessages: 20,
      /**
       * The notepad: resource-scoped, so what the operator taught the
       * assistant on Monday still holds in a fresh thread on Friday. The
       * resource is the workspace — operators sharing one share its notes,
       * exactly as they share its brand memory.
       */
      workingMemory: {
        enabled: true,
        scope: "resource",
        template: WORKING_MEMORY_TEMPLATE,
      },
      /**
       * Vector recall across all of the workspace's threads, for decisions
       * that scrolled out of `lastMessages` weeks ago. `messageRange` pulls
       * the surrounding turns so a match arrives as a moment, not a fragment.
       * No `indexConfig`: the option is typed but unread in this version —
       * the store names and indexes the table by embedding dimension itself
       * (ivfflat, cosine), and dead config would only mislead.
       */
      ...(recall
        ? {
            semanticRecall: {
              topK: 4,
              messageRange: { before: 2, after: 1 },
              scope: "resource" as const,
            },
          }
        : {}),
      /**
       * Fires only when a thread has no title. The product's chat controller
       * always sets one from the first message, so in practice this titles
       * Studio conversations alone — with the cheap tier, resolved lazily so
       * importing this module never needs a key.
       */
      generateTitle: {
        model: () => resolveCheapModel(),
        instructions:
          "Name the conversation in its own language: a specific noun phrase, at most five words, no quotes.",
      },
    },
  });
}

let current = buildMemory();

/** The agent's `memory` — resolved per turn, so a boot-time upgrade lands. */
export function assistantMemory(): Memory {
  return current;
}

/** Swaps in the recall-enabled shape. `enableAssistantRecall` is the caller. */
export function attachRecall(recall: RecallInfra): void {
  current = buildMemory(recall);
}
