import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InvalidTransitionError,
  availableActions,
  canTransition,
  nextStatus,
} from "./state-machine.ts";

test("a proposal flows to approved then scheduled", () => {
  assert.equal(nextStatus("propose", "draft"), "pending_approval");
  assert.equal(nextStatus("approve", "pending_approval"), "approved");
  assert.equal(nextStatus("schedule", "approved"), "scheduled");
});

test("rework returns a post to the reviewer", () => {
  assert.equal(nextStatus("request_changes", "pending_approval"), "needs_changes");
  assert.equal(nextStatus("edit", "needs_changes"), "pending_approval");
  assert.equal(nextStatus("approve", "needs_changes"), "approved");
});

test("publishing is reachable only by claiming a scheduled post", () => {
  assert.equal(nextStatus("claim", "scheduled"), "publishing");
  for (const from of ["draft", "approved", "published", "failed"] as const) {
    assert.equal(canTransition("claim", from), false, `claim should reject ${from}`);
  }
});

test("a failed publish can be retried but not re-claimed directly", () => {
  assert.equal(nextStatus("publish_failed", "publishing"), "failed");
  assert.equal(nextStatus("retry", "failed"), "scheduled");
  assert.equal(canTransition("claim", "failed"), false);
});

test("published posts are terminal", () => {
  for (const action of ["approve", "schedule", "cancel", "claim", "retry"] as const) {
    assert.equal(
      canTransition(action, "published"),
      false,
      `${action} must not apply to a published post`,
    );
  }
});

test("an expired proposal is never published, only re-planned", () => {
  assert.equal(nextStatus("expire", "pending_approval"), "expired");
  // The only way forward is back through scheduling by the agent.
  assert.equal(canTransition("claim", "expired"), false);
  assert.equal(nextStatus("schedule", "expired"), "scheduled");
});

test("illegal transitions throw with a useful message", () => {
  assert.throws(
    () => nextStatus("approve", "published"),
    (error: unknown) => {
      assert.ok(error instanceof InvalidTransitionError);
      assert.match(error.message, /Cannot approve a post in state "published"/);
      return true;
    },
  );
});

test("the UI can enumerate what a reviewer may do next", () => {
  const pending = availableActions("pending_approval");
  assert.deepEqual(pending.sort(), [
    "approve",
    "cancel",
    "expire",
    "reject",
    "request_changes",
  ]);
  assert.deepEqual(availableActions("published"), []);
});
