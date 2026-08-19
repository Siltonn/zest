import { Mastra } from "@mastra/core";
import { analyst } from "./agents/analyst/agent.ts";
import { assistant } from "./agents/assistant/agent.ts";
import { community } from "./agents/community/agent.ts";
import { copywriter } from "./agents/copywriter/agent.ts";
import { researcher } from "./agents/researcher/agent.ts";
import { strategist } from "./agents/strategist/agent.ts";
import { planCycle } from "./workflows/plan-cycle.ts";
import { ALL_TOOLS } from "./tools/index.ts";

/**
 * The one registry both runtimes build from. The server's instance carries a
 * Postgres store so the assistant's memory has somewhere to live; Studio's
 * carries LibSQL, observability and its context middleware. Same agents, same
 * workflow, same tools — only the infrastructure differs, so what Studio
 * exercises is what production runs.
 */

/**
 * Keyed by the agent's own id. Studio's per-agent trace filter matches the
 * registry key against the entity id on the span — registering under a
 * different key quietly empties the Traces tab.
 */
export const AGENTS = Object.fromEntries(
  [researcher, strategist, copywriter, community, analyst, assistant].map(
    (agent) => [agent.id, agent],
  ),
);

/** Workflows are for orchestration; the stages themselves are functions. */
export const WORKFLOWS = { [planCycle.id]: planCycle };

type MastraExtras = Omit<
  NonNullable<ConstructorParameters<typeof Mastra>[0]>,
  "agents" | "workflows" | "tools"
>;

export function createMastra(extras: MastraExtras = {}): Mastra {
  return new Mastra({
    agents: AGENTS,
    workflows: WORKFLOWS,
    // Registered as well as attached to the agents, so a single tool can be
    // run on its own from Studio's Tools tab.
    tools: ALL_TOOLS as never,
    ...extras,
  });
}
