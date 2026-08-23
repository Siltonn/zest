import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeScopes } from "./scopes.ts";
import { isUserBacked } from "./actor.ts";

/**
 * Scope interpretation is security policy, so its edges are pinned here:
 * legacy keys must keep working at their old power, and nothing may gain
 * power from a value we do not recognize.
 */

describe("normalizeScopes", () => {
  test("legacy shapes mean full power", () => {
    // Keys minted before scopes were enforced: ["read","write"] via the old
    // controller, [] via hand inserts. Both were unrestricted in practice.
    for (const legacy of [[], ["read", "write"], ["write"]]) {
      const scopes = normalizeScopes(legacy);
      assert.ok(scopes.has("read"));
      assert.ok(scopes.has("propose"));
      assert.ok(scopes.has("approve"));
    }
  });

  test("explicit scopes stay narrow", () => {
    const scopes = normalizeScopes(["read", "propose"]);
    assert.ok(scopes.has("propose"));
    assert.ok(!scopes.has("approve"));
  });

  test("read is always present", () => {
    assert.ok(normalizeScopes(["approve"]).has("read"));
  });

  test("unknown values grant nothing", () => {
    const scopes = normalizeScopes(["read", "admin", "root", "grant_autonomy"]);
    assert.ok(!scopes.has("approve"));
    assert.ok(!scopes.has("propose"));
  });
});

describe("isUserBacked", () => {
  test("humans and user-authorized MCP sessions qualify", () => {
    assert.ok(isUserBacked({ kind: "human", userId: "u1" }));
    assert.ok(isUserBacked({ kind: "mcp", clientId: "c1", userId: "u1" }));
  });

  test("standing machine credentials do not", () => {
    assert.ok(!isUserBacked({ kind: "mcp", clientId: "c1" }));
    assert.ok(!isUserBacked({ kind: "api", keyId: "k1" }));
    assert.ok(!isUserBacked({ kind: "agent", runId: "r1" }));
    assert.ok(!isUserBacked({ kind: "system", source: "cron" }));
  });
});
