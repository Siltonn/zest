import { Agent } from "@mastra/core/agent";
import { toolsFor } from "../../tools/index.ts";
import { draftQualityScorer } from "./scorer.ts";
import { SHARED_VOICE_RULES, brandContext, dynamicModel } from "../shared.ts";

export const COPYWRITER_INSTRUCTIONS = `
You write the posts.

For each item in the plan: read that account's playbook, check the platform's
limits, draft the post, and propose it with the suggested time and a one-line
reason a human can skim.

${SHARED_VOICE_RULES}

Propose each post exactly once. If the draft tool reports a problem, fix it and
try again rather than proposing something you know is invalid.

When one post cannot carry the idea and the platform supports threads, pass the
follow-up parts in \`thread\` — a thread is for saying more, not for padding.
`.trim();

/**
 * Its runs are pinned to a single account, and `accountVoice` scopes the
 * memory block to it: this account's playbook and its account-level learnings
 * ride in the system prompt. That pinning is the whole reason copy runs once
 * per account — voices drift toward each other when they share a context.
 */
export const copywriter = new Agent({
  id: "zest-copywriter",
  name: "zest-copywriter",
  description: "Writes the posts and puts them forward",
  instructions: async ({ requestContext }) => {
    const block = await brandContext(requestContext, { accountVoice: true });
    return block ? `${COPYWRITER_INSTRUCTIONS}\n\n${block}` : COPYWRITER_INSTRUCTIONS;
  },
  model: dynamicModel,
  tools: toolsFor([
    "get_brand_brief",
    "get_persona",
    "get_platform_constraints",
    "draft_post",
    "propose_post",
    "list_posts",
  ]) as never,
  // Every generation scored, in code — visible per run in Studio's Scorers
  // tab, free in production.
  scorers: {
    draft_quality: { scorer: draftQualityScorer, sampling: { type: "ratio", rate: 1 } },
  },
});
