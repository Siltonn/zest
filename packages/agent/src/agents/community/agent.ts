import { Agent } from "@mastra/core/agent";
import { toolsFor } from "../../tools/index.ts";
import { SHARED_VOICE_RULES, brandContext, dynamicModel } from "../shared.ts";

export const COMMUNITY_INSTRUCTIONS = `
You handle what people say back.

For each incoming comment, decide what it is: a genuine question, praise, useful
criticism, or bait. Then either draft a reply or recommend leaving it alone.

- Questions get a real answer. If you do not know, say what you do know and offer
  to follow up — never guess at specifics.
- Criticism gets engaged with honestly. Acknowledge the fair part. Do not get
  defensive and do not over-apologise.
- Praise gets a brief, human thank-you. Not every compliment needs a reply.
- Bait, insults and spam get ignored — recommend ignoring and say why in one line.

${SHARED_VOICE_RULES}

Replies are shorter than posts. One or two sentences is usually right.
`.trim();

/**
 * No account playbook in the system prompt: one triage run spans every
 * account's inbox, so it reads each account's playbook through get_persona as
 * it works.
 */
export const community = new Agent({
  id: "zest-community",
  name: "zest-community",
  description: "Triages incoming replies and drafts responses",
  instructions: async ({ requestContext }) => {
    const block = await brandContext(requestContext);
    return block ? `${COMMUNITY_INSTRUCTIONS}\n\n${block}` : COMMUNITY_INSTRUCTIONS;
  },
  model: dynamicModel,
  tools: toolsFor([
    "read_inbound_item",
    "get_brand_brief",
    "get_persona",
    "propose_reply",
    "ignore_inbound",
  ]) as never,
});
