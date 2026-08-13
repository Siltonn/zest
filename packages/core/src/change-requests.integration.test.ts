import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, and, eq, schema, type Database } from "@zest/db";
import { agent, human } from "@zest/shared";
import { approve, listPending, open, reject } from "./change-requests.ts";
import { listInbox } from "./approvals.ts";
import { decide } from "./autonomy.ts";
import { readMemory, writeMemory } from "./memory.ts";

/**
 * Changes the agent proposes about itself.
 *
 * These have to be tested against a real database because approving one is not
 * a status flip: it writes a new version of a memory document, or grants a rule
 * that changes what every tool may do afterwards. The interesting assertions
 * are all about that side effect actually landing — and about a second approval
 * not landing it twice.
 */

const url = process.env.DATABASE_URL;

describe("change requests", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `changes-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    await writeMemory(db, {
      workspaceId,
      kind: "strategy",
      contentMd: "# Strategy\n\nPost twice a week.",
      actor: human("tester"),
    });
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  test("a proposed memory rewrite reaches the inbox", async () => {
    const current = await readMemory(db, workspaceId, "strategy");
    await open(db, {
      workspaceId,
      kind: "memory",
      summary: "Proposed rewrite of strategy",
      rationale: "Build-time posts outperformed feature posts.",
      payload: {
        kind: "strategy",
        accountId: null,
        before: current?.contentMd ?? null,
        after: "# Strategy\n\nPost twice a week.\nLead with build-time results.",
      },
    });

    // The inbox is the whole point: a proposal nobody can see is not a proposal.
    const inbox = await listInbox(db, workspaceId);
    const item = inbox.find((i) => i.kind === "memory");
    assert.ok(item, "the memory proposal should be listed");
    assert.match(item.body, /build-time results/i);
    assert.match(item.before ?? "", /Post twice a week/);
  });

  test("approving rewrites the document rather than recording an intention", async () => {
    const [pending] = await listPending(db, workspaceId);
    assert.ok(pending);

    const result = await approve(db, workspaceId, pending.id, human("tester"));
    assert.equal(result.kind, "memory");

    const updated = await readMemory(db, workspaceId, "strategy");
    assert.match(updated!.contentMd, /Lead with build-time results/);
    assert.equal(updated!.version, 2, "approval should publish a new version");
  });

  test("a decided request cannot be decided again", async () => {
    const [decided] = await db
      .select()
      .from(schema.changeRequests)
      .where(
        and(
          eq(schema.changeRequests.workspaceId, workspaceId),
          eq(schema.changeRequests.status, "approved"),
        ),
      );
    assert.ok(decided);

    await assert.rejects(
      () => approve(db, workspaceId, decided.id, human("someone-else")),
      /already been decided/,
      "a second approval must not write a third version",
    );

    const doc = await readMemory(db, workspaceId, "strategy");
    assert.equal(doc!.version, 2, "the document should be untouched");
  });

  test("approving an autonomy request grants the rule it asked for", async () => {
    const before = await decide(db, {
      workspaceId,
      action: "schedule_post",
      connectorId: "pomelo",
    });
    assert.equal(before.mode, "approve", "nothing is granted yet");

    const request = await open(db, {
      workspaceId,
      kind: "autonomy",
      summary: "Asking to schedule post without review",
      rationale: "18 proposals approved unchanged.",
      payload: {
        action: "schedule_post",
        connectorId: "pomelo",
        accountId: null,
        consecutiveCleanApprovals: 18,
      },
      agentRunId: null,
    });

    await approve(db, workspaceId, request.id, human("tester"));

    // The same tool, the same prompt — a different answer from the guard.
    const after = await decide(db, {
      workspaceId,
      action: "schedule_post",
      connectorId: "pomelo",
    });
    assert.equal(after.mode, "auto", "the granted rule should now apply");
  });

  test("rejecting changes nothing but is recorded", async () => {
    const request = await open(db, {
      workspaceId,
      kind: "memory",
      summary: "Proposed rewrite of strategy",
      payload: {
        kind: "strategy",
        accountId: null,
        before: null,
        after: "# Strategy\n\nPost hourly. Engagement is a numbers game.",
      },
    });

    await reject(db, workspaceId, request.id, human("tester"), "Too spammy");

    const doc = await readMemory(db, workspaceId, "strategy");
    assert.doesNotMatch(doc!.contentMd, /numbers game/);

    const [log] = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entityId, request.id));
    assert.equal(log?.action, "reject_change_request");

    const pending = await listPending(db, workspaceId);
    assert.equal(pending.length, 0, "a rejected request leaves the inbox");
  });

  test("an agent-authored request is attributed to its run", async () => {
    const [run] = await db
      .insert(schema.agentRuns)
      .values({ workspaceId, trigger: "cron_analyze", status: "succeeded" })
      .returning();

    const request = await open(db, {
      workspaceId,
      kind: "memory",
      summary: "Proposed rewrite of learnings",
      payload: {
        kind: "learnings",
        accountId: null,
        before: null,
        after: "# Learnings\n\nQuestions in the first line double replies.",
      },
      agentRunId: run!.id,
    });

    // Being able to open the transcript behind a proposal is what makes
    // approving it an informed decision rather than a coin flip.
    const [item] = (await listInbox(db, workspaceId)).filter(
      (i) => i.id === request.id,
    );
    assert.equal(item?.agentRunId, run!.id);

    await approve(db, workspaceId, request.id, agent(run!.id));
  });
});
