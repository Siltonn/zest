import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { PostgresStore } from "@mastra/pg";
import { closeDatabase, createDatabase, eq, schema, sql, type Database } from "@zest/db";
import { NoModelConfiguredError } from "../../models.ts";
import { createMastra } from "../../mastra.ts";
import { scriptedModel, textTurn, toolTurn } from "../testing.ts";
import { runChat } from "./chat.ts";
import { openChatThread, readChatThread } from "./threads.ts";

/**
 * The product chat, minus the HTTP: tools run for real, and — the part the
 * old string-splicing history could never guarantee — the second turn's model
 * call actually contains the first turn, loaded by the assistant's memory
 * from storage.
 */

const url = process.env.DATABASE_URL;

describe("assistant chat", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let store: PostgresStore;
  let mastra: ReturnType<typeof createMastra>;

  before(async () => {
    db = createDatabase(url!);

    // Registering the shared agents on an instance with a storage is what
    // gives the assistant's memory somewhere to live. The same adapter
    // production uses, on the same database, in a schema of its own — the
    // store creates it here and after() drops it whole. Built inside before()
    // so a missing DATABASE_URL still skips the suite instead of failing to
    // construct the store.
    store = new PostgresStore({
      id: "assistant-test",
      connectionString: url!,
      schemaName: "mastra_test",
      max: 2,
    });
    mastra = createMastra({ storage: store });

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `assistant-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));

    // A single-connection handle so the session setting is guaranteed to
    // apply to the drop — otherwise the cascade's NOTICE gets relayed through
    // postgres.js's default logger and reads like a failure in the test output.
    const cleanup = createDatabase(url!, { max: 1 });
    await cleanup.execute(sql`set client_min_messages = warning`);
    await cleanup.execute(sql`drop schema if exists mastra_test cascade`);
    await closeDatabase(cleanup);

    // Both pools must close or the test process never exits.
    await store.close();
    await closeDatabase(db);
  });

  test("tools run and the reply reports them", async () => {
    const result = await runChat({
      db,
      workspaceId,
      message: "What went out recently?",
      model: scriptedModel("scripted-assistant", [
        toolTurn("list_posts", {}),
        textTurn("Nothing has gone out yet."),
      ]),
    });

    assert.equal(result.reply, "Nothing has gone out yet.");
    assert.deepEqual(result.toolCalls, [{ tool: "list_posts" }]);
    // No thread, no persistence — and no ids to annotate.
    assert.equal(result.messageId, undefined);
  });

  test("the second turn's model call contains the first turn, via memory", async () => {
    const threadId = crypto.randomUUID();
    // Pre-titled, as the product controller always does: an untitled thread
    // would fire generateTitle after the turn, which has no scripted budget.
    await openChatThread(mastra, workspaceId, {
      threadId,
      title: "Persistence test",
      existing: false,
    });
    const model = scriptedModel("remembering-assistant", [
      textTurn("Noted: teal it is."),
      textTurn("Teal."),
    ]);

    const first = await runChat({
      db,
      workspaceId,
      thread: threadId,
      message: "My favorite color is teal. Remember that.",
      model,
    });
    assert.ok(first.messageId, "the persisted reply reports its id");
    assert.ok(first.userMessageId);

    const second = await runChat({
      db,
      workspaceId,
      thread: threadId,
      message: "What is my favorite color?",
      model,
    });
    assert.equal(second.reply, "Teal.");

    // The proof the hand-rolled history never had: what the model was
    // actually sent on turn two includes turn one, from storage.
    const promptSeen = JSON.stringify(model.calls[1]?.prompt ?? "");
    assert.match(promptSeen, /favorite color is teal/);

    // And the thread surface reads the whole conversation back in order.
    const thread = await readChatThread(mastra, workspaceId, threadId);
    assert.equal(thread?.messages.length, 4);
    assert.deepEqual(
      thread?.messages.map((m) => m.role),
      ["user", "assistant", "user", "assistant"],
    );
  });

  test("keyless and uninjected still throws the error the controller catches", async () => {
    const saved = { ...process.env };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await assert.rejects(
        runChat({ db, workspaceId, message: "hello" }),
        (error: unknown) => error instanceof NoModelConfiguredError,
      );
    } finally {
      Object.assign(process.env, saved);
    }
  });
});
