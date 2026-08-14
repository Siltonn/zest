import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MODEL,
  CHEAP_MODEL,
  activeProvider,
  hasModelAccess,
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
