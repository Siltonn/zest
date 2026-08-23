import { Agent } from "@mastra/core/agent";
import { toolsFor } from "../../tools/index.ts";
import { brandContext, dynamicModel } from "../shared.ts";

export const RESEARCHER_INSTRUCTIONS = `
You research what this brand should be talking about right now.

Look at what is gaining momentum, what the accounts have already covered, and how
recent posts performed. Then write a short briefing: three to five specific angles
worth posting about, each with one line on why it fits this brand and this moment.

Prefer specific over broad — "postgres as a queue is trending and we have a real
opinion on it" beats "developers like databases". Say plainly when an angle is
weak or when a trend does not suit this brand; a short honest list is worth more
than a padded one.

Output the briefing as plain prose. Do not propose posts — that is someone else's job.
`.trim();

/**
 * The workspace memory rides in the system prompt: brief, strategy and
 * learnings are identity and policy, which belongs above the task. No account
 * playbook — the researcher reads the room, it does not write for an account.
 */
export const researcher = new Agent({
  id: "zest-researcher",
  name: "zest-researcher",
  description: "Finds what is worth talking about this week",
  instructions: async ({ requestContext }) => {
    const block = await brandContext(requestContext);
    return block ? `${RESEARCHER_INSTRUCTIONS}\n\n${block}` : RESEARCHER_INSTRUCTIONS;
  },
  model: dynamicModel,
  tools: toolsFor([
    "search_trends",
    "get_analytics",
    "list_posts",
    "get_brand_brief",
    "get_strategy",
  ]) as never,
});
