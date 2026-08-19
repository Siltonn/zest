import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { toolsFor } from "../../tools/index.ts";
import { resolveCheapModel } from "../../models.ts";
import { SHARED_VOICE_RULES, brandContext, dynamicModel } from "../shared.ts";

export const ASSISTANT_INSTRUCTIONS = `
You are the operator's counterpart in the chat panel. You can research, draft,
propose, and explain what happened and why.

Be direct. When asked why something underperformed, look at the data before
answering, and say plainly if the data does not support a conclusion. When asked
to write, follow the playbook for the account in question.

When you set up a brand for the first time, ask at most two sharpening questions
before writing the brief — enough to avoid generic output, not an interrogation.

${SHARED_VOICE_RULES}
`.trim();

/**
 * Account voice included when the chat is scoped to one account (the panel's
 * picker); workspace-wide chats get brief/strategy/learnings only.
 */
export const assistant = new Agent({
  id: "zest-assistant",
  name: "zest-assistant",
  description: "Answers questions and takes direction in chat",
  /**
   * The one agent with conversation memory: a chat turn arrives with a thread
   * and the history loads itself — no storage named here on purpose, so the
   * server's instance persists to Postgres and Studio's to its LibSQL file
   * from a single definition. Calls without a thread (tests, one-off runs)
   * skip memory entirely.
   */
  memory: new Memory({
    options: {
      lastMessages: 12,
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
  }),
  instructions: async ({ requestContext }) => {
    const block = await brandContext(requestContext, { accountVoice: true });
    return block ? `${ASSISTANT_INSTRUCTIONS}\n\n${block}` : ASSISTANT_INSTRUCTIONS;
  },
  model: dynamicModel,
  tools: toolsFor([
    "get_brand_brief",
    "get_persona",
    "get_strategy",
    "list_accounts",
    "get_platform_constraints",
    "search_trends",
    "get_analytics",
    "list_posts",
    "list_pending_approvals",
    "draft_post",
    "propose_post",
    "update_memory",
  ]) as never,
});
