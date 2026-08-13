import assert from "node:assert/strict";
import { test } from "node:test";
import { getConnector, listConnectorMeta } from "./registry.ts";
import { createPkcePair, pkceCookieName, signState, verifyState } from "./oauth.ts";

const SECRET = "test-oauth-signing-secret";

test("every connector reports the constraints the UI and prompts rely on", () => {
  for (const meta of listConnectorMeta()) {
    assert.ok(meta.charLimit > 0, `${meta.id} must declare a character limit`);
    assert.ok(meta.name.length > 0);
    assert.ok(Array.isArray(meta.features));
  }
});

test("validation rejects posts over a platform's limit", () => {
  const bluesky = getConnector("bluesky");
  const tooLong = { text: "x".repeat(301), media: [] };
  const issues = bluesky.validate(tooLong);
  assert.ok(issues.some((i) => i.severity === "error" && i.field === "text"));
});

test("validation warns as a post approaches the limit", () => {
  const bluesky = getConnector("bluesky");
  const issues = bluesky.validate({ text: "x".repeat(295), media: [] });
  assert.ok(issues.some((i) => i.severity === "warning"));
  assert.ok(!issues.some((i) => i.severity === "error"));
});

test("validation counts characters, not UTF-16 code units", () => {
  const pomelo = getConnector("pomelo");
  // 200 emoji are 200 characters to a user but 400 code units to naive code.
  const issues = pomelo.validate({ text: "🍊".repeat(200), media: [] });
  assert.ok(!issues.some((i) => i.severity === "error"), "should fit within 420");
});

test("validation rejects more images than a platform accepts", () => {
  const pomelo = getConnector("pomelo");
  const media = Array.from({ length: 5 }, (_, i) => ({ url: `https://x/${i}.png` }));
  const issues = pomelo.validate({ text: "hello", media });
  assert.ok(issues.some((i) => i.field === "media" && i.severity === "error"));
});

test("an empty post is an error on every platform", () => {
  for (const meta of listConnectorMeta()) {
    const issues = getConnector(meta.id).validate({ text: "", media: [] });
    assert.ok(
      issues.some((i) => i.severity === "error"),
      `${meta.id} should reject an empty post`,
    );
  }
});

test("unknown connectors fail loudly, listing what is available", () => {
  assert.throws(() => getConnector("tiktok"), /Unknown connector "tiktok"/);
});

test("signed OAuth state round-trips", () => {
  const state = signState(
    {
      workspaceId: "ws-1",
      connectorId: "mastodon",
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    SECRET,
  );
  const payload = verifyState(state, SECRET);
  assert.equal(payload?.workspaceId, "ws-1");
  assert.equal(payload?.connectorId, "mastodon");
});

test("tampered or foreign-signed state is rejected", () => {
  const state = signState(
    { workspaceId: "ws-1", connectorId: "m", exp: Math.floor(Date.now() / 1000) + 600 },
    SECRET,
  );
  assert.equal(verifyState(state, "different-secret"), null);
  assert.equal(verifyState(`${state}x`, SECRET), null);
  assert.equal(verifyState("garbage", SECRET), null);
});

test("expired state is rejected even with a valid signature", () => {
  const state = signState(
    { workspaceId: "ws-1", connectorId: "m", exp: Math.floor(Date.now() / 1000) - 1 },
    SECRET,
  );
  assert.equal(verifyState(state, SECRET), null);
});

test("PKCE challenge differs from its verifier", () => {
  const pair = createPkcePair();
  assert.notEqual(pair.verifier, pair.challenge);
  assert.ok(pair.verifier.length >= 43);
});

test("parallel connect flows get distinct PKCE cookies", () => {
  assert.notEqual(pkceCookieName("state-a"), pkceCookieName("state-b"));
  assert.equal(pkceCookieName("state-a"), pkceCookieName("state-a"));
});
