import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MODEL,
  CHEAP_MODEL,
  EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_MODEL,
  OPENROUTER_EMBEDDING_MODEL,
  activeProvider,
  hasModelAccess,
  resolveEmbedder,
  resolvedModelId,
  toOpenRouterModel,
} from "./models.ts";

/**
 * Provider selection.
 *
 * The model-slug mapping is the part that fails quietly: a direct-provider id
 * sent to OpenRouter comes back as a confusing 404 rather than a wrong-name
 * error, so it is worth pinning down.
 */

test("the built-in defaults map to real OpenRouter slugs", () => {
  assert.equal(toOpenRouterModel(DEFAULT_MODEL), "anthropic/claude-sonnet-5");
  assert.equal(toOpenRouterModel(CHEAP_MODEL), "anthropic/claude-haiku-4.5");
});

test("an explicit vendor/model slug is passed through untouched", () => {
  // Anything already namespaced is the operator's choice, including vendors we
  // have never heard of — rewriting it would defeat the point of OpenRouter.
  for (const id of [
    "openai/gpt-4o",
    "google/gemini-2.5-flash-lite",
    "meta-llama/llama-3.3-70b-instruct",
  ]) {
    assert.equal(toOpenRouterModel(id), id);
  }
});

test("provider order puts OpenRouter first", () => {
  // Whichever key is present wins, in a fixed order, so a machine with several
  // configured behaves the same everywhere.
  assert.equal(
    activeProvider({ OPENROUTER_API_KEY: "x", ANTHROPIC_API_KEY: "y" } as never),
    "openrouter",
  );
  assert.equal(
    activeProvider({ ANTHROPIC_API_KEY: "y", OPENAI_API_KEY: "z" } as never),
    "anthropic",
  );
  assert.equal(activeProvider({ OPENAI_API_KEY: "z" } as never), "openai");
  assert.equal(activeProvider({} as never), "none");
});

test("any single key is enough to switch the thinking steps on", () => {
  assert.equal(hasModelAccess({ OPENROUTER_API_KEY: "x" } as never), true);
  assert.equal(hasModelAccess({ ANTHROPIC_API_KEY: "x" } as never), true);
  assert.equal(hasModelAccess({ OPENAI_API_KEY: "x" } as never), true);
  assert.equal(hasModelAccess({} as never), false);
});

test("the cheap tier stays cheap on every provider", () => {
  // Otherwise "use the cheap model" quietly means "use the flagship".
  assert.equal(
    resolvedModelId(CHEAP_MODEL, { OPENROUTER_API_KEY: "x" } as never),
    "anthropic/claude-haiku-4.5",
  );
  assert.equal(
    resolvedModelId(CHEAP_MODEL, { ANTHROPIC_API_KEY: "x" } as never),
    CHEAP_MODEL,
  );
  assert.equal(
    resolvedModelId(CHEAP_MODEL, { OPENAI_API_KEY: "x" } as never),
    "gpt-4o-mini",
  );
});

test("embeddings follow the provider chain, minus Anthropic", () => {
  // OpenRouter's catalogue refuses `openai/*` embedding models, so its leg
  // defaults to Qwen rather than sharing the OpenAI default.
  assert.equal(
    resolveEmbedder({ OPENROUTER_API_KEY: "x", OPENAI_API_KEY: "z" } as never)?.id,
    OPENROUTER_EMBEDDING_MODEL,
  );
  assert.equal(
    resolveEmbedder({ OPENAI_API_KEY: "z" } as never)?.id,
    OPENAI_EMBEDDING_MODEL,
  );
  // Anthropic has no embeddings API: chat on, recall off — not an error.
  assert.equal(resolveEmbedder({ ANTHROPIC_API_KEY: "y" } as never), null);
  assert.equal(resolveEmbedder({} as never), null);
});

test("an embedding override rides whichever provider is active", () => {
  const env = {
    OPENROUTER_API_KEY: "x",
    ZEST_EMBEDDING_MODEL: "mistralai/codestral-embed-2505",
  } as never;
  assert.equal(resolveEmbedder(env)?.id, "mistralai/codestral-embed-2505");
});

test("every leg asks for the same, indexable dimension count", () => {
  // pgvector refuses to index beyond 2000 dimensions; the shared setting is
  // what keeps the OpenRouter and OpenAI legs interchangeable on disk.
  assert.ok(EMBEDDING_DIMENSIONS <= 2000);
  for (const env of [{ OPENROUTER_API_KEY: "x" }, { OPENAI_API_KEY: "z" }]) {
    assert.equal(
      resolveEmbedder(env as never)?.options.providerOptions.openai.dimensions,
      EMBEDDING_DIMENSIONS,
    );
  }
});

test("runs record the id that will actually answer", () => {
  assert.equal(
    resolvedModelId(undefined, { OPENROUTER_API_KEY: "x" } as never),
    "anthropic/claude-sonnet-5",
  );
  assert.equal(
    resolvedModelId(undefined, { ANTHROPIC_API_KEY: "x" } as never),
    DEFAULT_MODEL,
  );
  // No key: null, matching hasModelAccess — a run that cannot think records
  // no model rather than a lie.
  assert.equal(resolvedModelId(undefined, {} as never), null);
});
