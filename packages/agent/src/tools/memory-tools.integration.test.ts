import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import { autonomy, memory } from "@zest/core";
import { agent as agentActor } from "@zest/shared";
import { buildRequestContext } from "../context.ts";
import { WRITE_TOOLS } from "./write.ts";

/**
 * The update_memory tool against the scope contract: the model gets a
 * correctable error for a wrong layer, and the analyst's account-scoped
 * learnings actually land — the write-only black hole this design replaced.
 */

const url = process.env.DATABASE_URL;

describe("memory tools", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let accountId: string;
  let runId: string;

  const context = () =>
    buildRequestContext({
      db,
      workspaceId,
      actor: agentActor(runId, "analyst"),
      runId,
    });

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `memory-tools-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    const [account] = await db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId,
        connectorId: "pomelo",
        handle: `memtool-${Date.now()}`,
        displayName: "Memory tools test",
      })
      .returning();
    accountId = account!.id;

    const [run] = await db
      .insert(schema.agentRuns)
      .values({ workspaceId, trigger: "cron_analyze", role: "analyst" })
      .returning();
    runId = run!.id;

    // The auto path is the one that writes directly; learnings are not an
    // identity document, so a granted rule lets them through without review.
    await autonomy.grantAutonomy(db, {
      workspaceId,
      action: "update_memory",
      mode: "auto",
      grantedBy: "memory-tools-test",
    });
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  test("the wrong layer comes back as a correctable error, not a run failure", async () => {
    const strategyOnAccount = await WRITE_TOOLS.update_memory.execute!(
      {
        kind: "strategy",
        contentMd: "Post more.",
        accountId,
        reason: "test",
      },
      { requestContext: context() } as never,
    );
    assert.equal((strategyOnAccount as { ok: boolean }).ok, false);
    assert.match(
      (strategyOnAccount as { error: string }).error,
      /workspace-wide/,
    );

    const playbookWithoutAccount = await WRITE_TOOLS.update_memory.execute!(
      { kind: "persona", contentMd: "Blunt.", reason: "test" },
      { requestContext: context() } as never,
    );
    assert.equal((playbookWithoutAccount as { ok: boolean }).ok, false);
  });

  test("account-scoped learnings write through and reach that account's context", async () => {
    const result = await WRITE_TOOLS.update_memory.execute!(
      {
        kind: "learnings",
        contentMd: "Threads outperform single posts on this handle.",
        accountId,
        reason: "Three-week pattern",
      },
      { requestContext: context() } as never,
    );
    assert.equal((result as { outcome?: string }).outcome, "saved");

    const block = await memory.buildContext(db, workspaceId, accountId);
    assert.match(block, /What works on this account/);
    assert.match(block, /Threads outperform/);
  });
});
