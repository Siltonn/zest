import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import * as memory from "./memory.ts";

/**
 * The two-layer memory contract: which kinds live at which scope, and what an
 * account-scoped run actually sees. Pinned here so the API, the agent tool and
 * the approval flow cannot drift apart about it again — the write-only
 * account-scoped strategy this replaces was exactly that drift.
 */

const url = process.env.DATABASE_URL;

describe("memory scopes", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let accountId: string;
  const actor = { kind: "system" as const, source: "memory-test" };

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `memory-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    const [account] = await db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId,
        connectorId: "pomelo",
        handle: `memory-${Date.now()}`,
        displayName: "Memory test",
      })
      .returning();
    accountId = account!.id;
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  test("workspace-only kinds refuse an accountId; a playbook demands one", async () => {
    for (const kind of ["brand_brief", "strategy", "report"] as const) {
      await assert.rejects(
        memory.writeMemory(db, { workspaceId, kind, contentMd: "x", actor, accountId }),
        memory.MemoryScopeError,
      );
    }
    await assert.rejects(
      memory.writeMemory(db, { workspaceId, kind: "persona", contentMd: "x", actor }),
      memory.MemoryScopeError,
    );
  });

  test("learnings live at both layers without shadowing each other", async () => {
    await memory.writeMemory(db, {
      workspaceId,
      kind: "learnings",
      contentMd: "Questions double replies.",
      actor,
    });
    await memory.writeMemory(db, {
      workspaceId,
      kind: "learnings",
      contentMd: "Long posts work here.",
      actor,
      accountId,
    });

    const workspace = await memory.readMemory(db, workspaceId, "learnings");
    const account = await memory.readMemory(db, workspaceId, "learnings", accountId);
    assert.match(workspace?.contentMd ?? "", /Questions/);
    assert.match(account?.contentMd ?? "", /Long posts/);
  });

  test("an account run's context stacks all five sections, an unscoped run three", async () => {
    await memory.writeMemory(db, {
      workspaceId,
      kind: "brand_brief",
      contentMd: "We make build tools.",
      actor,
    });
    await memory.writeMemory(db, {
      workspaceId,
      kind: "strategy",
      contentMd: "Founder pulls, company converts.",
      actor,
    });
    await memory.writeMemory(db, {
      workspaceId,
      kind: "persona",
      contentMd: "Blunt, first-person.",
      actor,
      accountId,
    });

    const scoped = await memory.buildContext(db, workspaceId, accountId);
    assert.match(scoped, /## Brand brief/);
    assert.match(scoped, /## This account's playbook/);
    assert.match(scoped, /## Current strategy/);
    assert.match(scoped, /## What we have learned so far/);
    assert.match(scoped, /## What works on this account/);
    assert.match(scoped, /Long posts work here/);

    // Workspace-wide runs see no account sections at all.
    const unscoped = await memory.buildContext(db, workspaceId);
    assert.doesNotMatch(unscoped, /playbook/);
    assert.doesNotMatch(unscoped, /What works on this account/);

    // A second account inherits the workspace layers but none of its sibling's.
    const [other] = await db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId,
        connectorId: "pomelo",
        handle: `memory-other-${Date.now()}`,
        displayName: "Other",
      })
      .returning();
    const sibling = await memory.buildContext(db, workspaceId, other!.id);
    assert.match(sibling, /## Brand brief/);
    assert.doesNotMatch(sibling, /Long posts work here/);
  });
});
