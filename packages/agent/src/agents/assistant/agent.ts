import { Agent } from "@mastra/core/agent";
import { toolsFor } from "../../tools/index.ts";
import { SHARED_VOICE_RULES, brandContext, dynamicModel } from "../shared.ts";
import { assistantMemory } from "./memory.ts";

export const ASSISTANT_INSTRUCTIONS = `
You are the operator's counterpart in the chat panel. You can research, draft,
propose, and explain what happened and why.

Be direct. When asked why something underperformed, look at the data before
answering, and say plainly if the data does not support a conclusion. When asked
to write, follow the playbook for the account in question.

When you set up a brand for the first time, ask at most two sharpening questions
before writing the brief — enough to avoid generic output, not an interrogation.

Two memories, two rules. Your working memory is a private notepad about the
operator and the work in progress — update it quietly when they state a
preference, correct you, or shift focus; never announce that you did. Brand
knowledge — voice, positioning, strategy, what performs — never goes in the
notepad: propose it through update_memory instead, so it is reviewed, versioned
and visible on the Memory page. If a note stops being true, remove it.

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
   * A resolver, not an instance: memory.ts rebuilds the memory with vector
   * recall when boot proves the environment supports it, and resolving per
   * turn is what lets that upgrade reach an agent constructed at import time.
   * Storage still arrives from whichever Mastra instance registers the agent.
   * Calls without a thread (tests, one-off runs) skip memory entirely.
   */
  memory: assistantMemory,
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
