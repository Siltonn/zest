import assert from "node:assert/strict";
import { test } from "node:test";
import { TokenVault } from "./encryption.ts";

const vault = new TokenVault("test-key-at-least-16-chars-long");

test("round-trips a token", () => {
  const token = "bsky-app-password-abc123";
  assert.equal(vault.decrypt(vault.encrypt(token)), token);
});

test("produces a different ciphertext each time", () => {
  // A fresh IV per encryption; identical tokens must not collide in the DB.
  assert.notEqual(vault.encrypt("same"), vault.encrypt("same"));
});

test("rejects a tampered ciphertext", () => {
  const encoded = vault.encrypt("secret");
  const [iv, tag, data] = encoded.split(".") as [string, string, string];
  const flipped = Buffer.from(data, "base64url");
  flipped[0] ^= 0xff;
  const tampered = [iv, tag, flipped.toString("base64url")].join(".");
  assert.throws(() => vault.decrypt(tampered));
});

test("rejects a token encrypted under a different key", () => {
  const other = new TokenVault("completely-different-key-here");
  assert.throws(() => vault.decrypt(other.encrypt("secret")));
});

test("rejects malformed input instead of returning garbage", () => {
  assert.throws(() => vault.decrypt("not-encrypted"));
  assert.throws(() => vault.decrypt("a.b"));
});

test("refuses a weak key", () => {
  assert.throws(() => new TokenVault("short"));
});
