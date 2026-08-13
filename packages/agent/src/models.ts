import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

/**
 * Provider selection.
 *
 * Mastra sits on the Vercel AI SDK, so staying provider-neutral costs nothing
 * and matters a lot for a self-hosted project: whoever runs Zest brings their
 * own key, and should not be forced onto ours.
 */

export type ModelChoice = {
  id: string;
  provider: "anthropic" | "openai" | "none";
};

export const DEFAULT_MODEL = "claude-sonnet-5";
/** Persona replies are high-volume and low-stakes, so they use the cheap tier. */
export const CHEAP_MODEL = "claude-haiku-4-5-20251001";

export function hasModelAccess(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY);
}

export function resolveModel(
  preferred?: string,
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof anthropic> | ReturnType<typeof openai> {
  const id = preferred ?? env.ZEST_MODEL ?? DEFAULT_MODEL;

  if (env.ANTHROPIC_API_KEY && !id.startsWith("gpt")) return anthropic(id);
  if (env.OPENAI_API_KEY) return openai(id.startsWith("gpt") ? id : "gpt-5");

  throw new NoModelConfiguredError();
}

/**
 * Thrown rather than returning a stub. Callers decide how to degrade — the
 * simulator falls back to templates, planning surfaces a clear message — and
 * the platform loop keeps working with no key at all.
 */
export class NoModelConfiguredError extends Error {
  constructor() {
    super(
      "No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable planning, drafting and reply triage.",
    );
    this.name = "NoModelConfiguredError";
  }
}
