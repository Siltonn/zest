import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  WEBHOOK_EVENT_TYPES,
  deliver,
  endpointsFor,
  generateSecret,
  signPayload,
  verifySignature,
  type WebhookEndpoint,
} from "./webhooks.ts";
import type { DomainEvent } from "./events.ts";

function endpoint(overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint {
  return {
    id: "endpoint-1",
    workspaceId: "ws-1",
    url: "https://example.test/hook",
    secret: "whsec_test",
    eventTypes: [],
    description: null,
    isActive: "true",
    lastStatus: null,
    lastError: null,
    lastDeliveredAt: null,
    consecutiveFailures: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

const event = (type: DomainEvent["type"]): DomainEvent =>
  ({ type, workspaceId: "ws-1" }) as DomainEvent;

describe("webhook signing", () => {
  test("a signature verifies against the same secret and body", () => {
    const body = JSON.stringify({ hello: "world" });
    const signature = signPayload("secret", 1_700_000_000, body);
    assert.ok(verifySignature("secret", 1_700_000_000, body, signature));
  });

  test("changing the body invalidates the signature", () => {
    const signature = signPayload("secret", 1_700_000_000, "{}");
    assert.equal(
      verifySignature("secret", 1_700_000_000, '{"evil":true}', signature),
      false,
    );
  });

  test("changing the timestamp invalidates the signature", () => {
    // The timestamp is inside the signed string precisely so a captured
    // delivery cannot be replayed later with a fresh header.
    const signature = signPayload("secret", 1_700_000_000, "{}");
    assert.equal(verifySignature("secret", 1_700_000_099, "{}", signature), false);
  });

  test("another secret does not verify", () => {
    const signature = signPayload("secret", 1_700_000_000, "{}");
    assert.equal(verifySignature("other", 1_700_000_000, "{}", signature), false);
  });

  test("a wrong-length signature is rejected rather than throwing", () => {
    // timingSafeEqual throws on length mismatch; the guard must come first.
    assert.doesNotThrow(() => verifySignature("secret", 1, "{}", "short"));
    assert.equal(verifySignature("secret", 1, "{}", "short"), false);
  });

  test("secrets are unique and recognisable", () => {
    const a = generateSecret();
    assert.match(a, /^whsec_[0-9a-f]{48}$/);
    assert.notEqual(a, generateSecret());
  });
});

describe("webhook subscription", () => {
  test("an endpoint with no filter gets the meaningful events", () => {
    assert.equal(endpointsFor([endpoint()], event("post.status_changed")).length, 1);
    assert.equal(endpointsFor([endpoint()], event("inbox.new")).length, 1);
  });

  test("high-frequency events are excluded unless named", () => {
    // A fast-forward emits hundreds of these; a subscriber who ticked nothing
    // wants the events that mean something, not their provider's rate limit.
    assert.equal(endpointsFor([endpoint()], event("sim.event")).length, 0);
    assert.equal(endpointsFor([endpoint()], event("run.progress")).length, 0);

    const explicit = endpoint({ eventTypes: ["sim.event"] });
    assert.equal(endpointsFor([explicit], event("sim.event")).length, 1);
  });

  test("a filter excludes everything it does not name", () => {
    const only = endpoint({ eventTypes: ["inbox.new"] });
    assert.equal(endpointsFor([only], event("inbox.new")).length, 1);
    assert.equal(endpointsFor([only], event("post.status_changed")).length, 0);
  });

  test("a disabled endpoint receives nothing", () => {
    const off = endpoint({ isActive: "false" });
    assert.equal(endpointsFor([off], event("post.status_changed")).length, 0);
  });

  test("the subscribable list is derived from the event union", () => {
    // Guards against the list drifting when a new event type is added.
    assert.ok(WEBHOOK_EVENT_TYPES.includes("post.status_changed"));
    assert.ok(WEBHOOK_EVENT_TYPES.includes("clock.advanced"));
    assert.equal(new Set(WEBHOOK_EVENT_TYPES).size, WEBHOOK_EVENT_TYPES.length);
  });
});

describe("webhook delivery", () => {
  const delivery = {
    id: "d-1",
    type: "post.status_changed" as const,
    workspaceId: "ws-1",
    createdAt: new Date().toISOString(),
    data: { postId: "p-1" },
  };

  test("sends a signed request the receiver can verify", async () => {
    let seen: { url: string; headers: Headers; body: string } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = {
        url,
        headers: new Headers(init.headers),
        body: init.body as string,
      };
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await deliver(endpoint(), delivery, fakeFetch);

    assert.deepEqual(result, { ok: true, status: 200 });
    assert.equal(seen!.headers.get("X-Zest-Event"), "post.status_changed");
    assert.equal(seen!.headers.get("X-Zest-Delivery"), "d-1");

    const timestamp = Number(seen!.headers.get("X-Zest-Timestamp"));
    const signature = seen!.headers.get("X-Zest-Signature")!.replace(/^v1=/, "");
    assert.ok(
      verifySignature("whsec_test", timestamp, seen!.body, signature),
      "a receiver following the documented scheme must be able to verify it",
    );
  });

  test("an HTTP error is reported, not thrown", async () => {
    const fakeFetch = (async () =>
      new Response("no thanks", { status: 503 })) as unknown as typeof fetch;

    const result = await deliver(endpoint(), delivery, fakeFetch);

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.match(result.error!, /no thanks/);
  });

  test("a transport failure is reported as status 0", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await deliver(endpoint(), delivery, fakeFetch);

    assert.equal(result.ok, false);
    assert.equal(result.status, 0, "0 distinguishes 'never arrived' from a real code");
    assert.match(result.error!, /ECONNREFUSED/);
  });
});
