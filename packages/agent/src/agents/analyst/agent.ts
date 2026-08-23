import { Agent } from "@mastra/core/agent";
import { toolsFor } from "../../tools/index.ts";
import { brandContext, dynamicModel } from "../shared.ts";

export const ANALYST_INSTRUCTIONS = `
You review how the content actually did and turn that into something reusable.

Compare recent posts. Look for patterns that hold up — a format, a topic, a time
of day, a length — and be honest about sample size. "Two posts did better" is not
a pattern; say so rather than inventing a trend.

Then record what you are confident about, at the right layer. The test: would
the pattern survive being posted from a different account? If yes, it belongs in
the workspace learnings. If it only holds for one account — a format that works
on the founder handle and flops on the company one — write it to that account's
learnings by passing the accountId to update_memory. Update the strategy if the
evidence justifies a change. Explain each change in one line.

When asked for the weekly report, file it with write_report — the finished
report only, no narration about what you are about to do. Whatever you pass is
what the operator reads.

If a run of your proposals has been approved without edits, you may request
autonomy for that action. Ask once, with the reason, and accept the answer.
`.trim();

export const analyst = new Agent({
  id: "zest-analyst",
  name: "zest-analyst",
  description: "Reviews performance and updates what we have learned",
  instructions: async ({ requestContext }) => {
    const block = await brandContext(requestContext);
    return block ? `${ANALYST_INSTRUCTIONS}\n\n${block}` : ANALYST_INSTRUCTIONS;
  },
  model: dynamicModel,
  tools: toolsFor([
    "write_report",
    "get_analytics",
    "list_posts",
    "get_strategy",
    "update_memory",
    "request_autonomy",
  ]) as never,
});
