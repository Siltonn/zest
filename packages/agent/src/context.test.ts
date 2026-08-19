import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RequestContext } from "@mastra/core/request-context";
import {
  buildRequestContext,
  maybeToolContext,
  readStageContext,
  readToolContext,
} from "./context.ts";
import type { Database } from "@zest/db";

/**
 * The context readers against the shapes that actually arrive: a real tool
 * context, nothing at all, and the junk the world can hand a dynamic
 * instructions callback — most importantly Studio's placeholder proxy, whose
 * `get` answers every missing key with the string "<key>".
 */

const db = { select: () => [] } as unknown as Database;

const full = () =>
  buildRequestContext({
    db,
    workspaceId: "ws-1",
    actor: { kind: "agent", runId: "run-1" },
    runId: "run-1",
  });

describe("context readers", () => {
  test("a real context passes through every reader", () => {
    const rc = full();
    assert.equal(maybeToolContext(rc)?.workspaceId, "ws-1");
    assert.equal(readToolContext(rc).runId, "run-1");
    assert.equal(readStageContext(rc).workspaceId, "ws-1");
  });

  test("an empty request context degrades to undefined, not a crash", () => {
    assert.equal(maybeToolContext(new RequestContext()), undefined);
    assert.equal(maybeToolContext(undefined), undefined);
  });

  test("Studio's placeholder proxy is not mistaken for a tool context", () => {
    // The agent-detail route wraps the context so missing keys come back as
    // "<key>" strings for the prompt-preview UI. Truthy, but not a context.
    const placeholder = new Proxy(new RequestContext(), {
      get(target, prop) {
        if (prop === "get") return (key: string) => target.get(key) ?? `<${key}>`;
        return Reflect.get(target, prop);
      },
    });
    assert.equal(maybeToolContext(placeholder), undefined);
  });

  test("a shape without a database is refused, wherever it came from", () => {
    const rc = new RequestContext();
    rc.set("zest", { workspaceId: "ws-1" });
    assert.equal(maybeToolContext(rc), undefined);
    assert.throws(() => readToolContext(rc), /context is missing/);
  });
});
