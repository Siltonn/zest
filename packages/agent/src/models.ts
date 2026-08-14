import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI, openai } from "@ai-sdk/openai";

/**
 * Provider selection.
 *
 * Mastra sits on the Vercel AI SDK, so staying provider-neutral costs nothing
 * and matters a lot for a self-hosted project: whoever runs Zest brings their
 * own key, and should not be forced onto ours.
 *
 * Three ways in, checked in that order. OpenRouter first because it is the one
 * people reach for to try a project without committing to an account anywhere —
 * one key, every model, and a spend cap.
 */

export type ProviderName = "openrouter" | "anthropic" | "openai" | "none";

export const DEFAULT_MODEL = "claude-sonnet-5";
/** Persona replies are high-volume and low-stakes, so they use the cheap tier. */
export const CHEAP_MODEL = "claude-haiku-4-5-20251001";

/**
 * Model choice is deliberately not a user setting.
 *
 * The roles that matter (strategist, copywriter) depend on tool calling, which
 * much of any router's catalogue does not support — a free picker is a footgun
 * that fails as "planning ran and nothing happened". Role-appropriate tiers
 * beat any single user choice, and names pinned in a database rot while
 * defaults in code update with releases. Operators who do want control get env
 * overrides (`ZEST_MODEL`, `ZEST_MODEL_CHEAP`); everyone else gets defaults
 * that work. The UI shows what is in use rather than asking.
 */

/**
 * OpenRouter namespaces its models by vendor, so the direct-provider ids do not
 * resolve there. Rather than making the operator translate, the two defaults are
 * mapped and anything else is passed through untouched — a slug that already
 * looks like `vendor/model` is taken at its word.
 */
const OPENROUTER_ALIASES: Record<string, string> = {
  [DEFAULT_MODEL]: "anthropic/claude-sonnet-5",
  [CHEAP_MODEL]: "anthropic/claude-haiku-4.5",
};

export function toOpenRouterModel(id: string): string {
  if (id.includes("/")) return id;
  return OPENROUTER_ALIASES[id] ?? `anthropic/${id}`;
}

export function hasModelAccess(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.OPENROUTER_API_KEY || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY,
  );
}

/** Which provider a run will actually use — surfaced in the UI, not inferred. */
export function activeProvider(
  env: NodeJS.ProcessEnv = process.env,
): ProviderName {
  if (env.OPENROUTER_API_KEY) return "openrouter";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY) return "openai";
  return "none";
}

// All three providers hand back the same `LanguageModelV2`; naming one of them
// keeps the declaration portable without taking a direct dependency on
// @ai-sdk/provider purely for a type.
export function resolveModel(
  preferred?: string,
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof anthropic> {
  const id = preferred ?? env.ZEST_MODEL ?? DEFAULT_MODEL;

  if (env.OPENROUTER_API_KEY) {
    const openrouter = createOpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      // Attribution headers OpenRouter shows on its activity page. Harmless if
      // absent, but they make a shared key's traffic legible.
      headers: {
        "HTTP-Referer": env.WEB_URL ?? "http://localhost:3000",
        "X-Title": "Zest",
      },
    });
    // `.chat()` rather than the default call: the AI SDK's OpenAI provider
    // defaults to the Responses API, which OpenRouter does not implement, and
    // the failure looks like a puzzling 404 rather than a wrong endpoint.
    return openrouter.chat(toOpenRouterModel(id));
  }

  if (env.ANTHROPIC_API_KEY && !id.startsWith("gpt")) return anthropic(id);
  if (env.OPENAI_API_KEY) {
    // The cheap tier has to stay cheap on OpenAI too, or "use the cheap model"
    // quietly means "use the flagship".
    if (id === CHEAP_MODEL) return openai("gpt-4o-mini");
    return openai(id.startsWith("gpt") ? id : "gpt-5");
  }

  throw new NoModelConfiguredError();
}

/** The cheap tier: high-volume, low-stakes work. Overridable, never pickable. */
export function resolveCheapModel(
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof anthropic> {
  return resolveModel(env.ZEST_MODEL_CHEAP ?? CHEAP_MODEL, env);
}

/**
 * The id a run will actually use, for the audit trail. Provenance is the
 * product's pitch, and "which model wrote this" is the first question when a
 * draft comes back wrong — so it is recorded per run, not inferred later.
 */
export function resolvedModelId(
  preferred?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!hasModelAccess(env)) return null;
  const id = preferred ?? env.ZEST_MODEL ?? DEFAULT_MODEL;
  if (env.OPENROUTER_API_KEY) return toOpenRouterModel(id);
  if (env.ANTHROPIC_API_KEY && !id.startsWith("gpt")) return id;
  if (id === CHEAP_MODEL) return "gpt-4o-mini";
  return id.startsWith("gpt") ? id : "gpt-5";
}

/**
 * Thrown rather than returning a stub. Callers decide how to degrade — the
 * simulator falls back to templates, planning surfaces a clear message — and
 * the platform loop keeps working with no key at all.
 */
export class NoModelConfiguredError extends Error {
  constructor() {
    super(
      "No LLM provider configured. Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY to enable planning, drafting and reply triage.",
    );
    this.name = "NoModelConfiguredError";
  }
}
