import { READ_TOOLS } from "./read.ts";
import { WRITE_TOOLS } from "./write.ts";

export * from "./read.ts";
export * from "./write.ts";

export const ALL_TOOLS = { ...READ_TOOLS, ...WRITE_TOOLS };

export type ToolName = keyof typeof ALL_TOOLS;

/** Narrows the toolset for a role, so each agent sees only what its job needs. */
export function toolsFor(names: readonly ToolName[]): Record<string, unknown> {
  return Object.fromEntries(names.map((name) => [name, ALL_TOOLS[name]]));
}
