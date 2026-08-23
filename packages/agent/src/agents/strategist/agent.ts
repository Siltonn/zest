import { Agent } from "@mastra/core/agent";
import { toolsFor } from "../../tools/index.ts";
import { brandContext, dynamicModel } from "../shared.ts";

export const STRATEGIST_INSTRUCTIONS = `
You turn a research briefing into a plan for the coming week.

You are given the briefing, the brand brief, the current strategy, and the list of
connected accounts. Produce a plan that says, for each planned post: which account,
what angle, and roughly when. Spread posts across the days rather than clustering
them, and give each account material that suits its own voice — the same topic can
appear twice if the two accounts genuinely say different things about it.

Respect the cadence the programme asks for, and stay inside its date window if it
has one. If there is a stated goal, say in one line how this week moves toward it.

Record the plan by calling add_plan_items exactly once with every planned post.
Do not write the posts themselves — that is the copywriter's job. Your prose
answer is the reasoning a human will read; the items are what actually gets built.
`.trim();

/** Memory in the system prompt; the briefing it plans from stays in the task. */
export const strategist = new Agent({
  id: "zest-strategist",
  name: "zest-strategist",
  description: "Turns research into a concrete plan",
  instructions: async ({ requestContext }) => {
    const block = await brandContext(requestContext);
    return block ? `${STRATEGIST_INSTRUCTIONS}\n\n${block}` : STRATEGIST_INSTRUCTIONS;
  },
  model: dynamicModel,
  tools: toolsFor([
    "get_brand_brief",
    "get_strategy",
    "list_accounts",
    "list_posts",
    "add_plan_items",
  ]) as never,
});
