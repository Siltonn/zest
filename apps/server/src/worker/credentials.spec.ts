import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import { getTokenVault } from "@zest/shared";
import type { AccountCredentials, Connector, RefreshedCredentials } from "@zest/connectors";
import { credentialsFor, needsRefresh } from "./credentials.ts";

/**
 * Token refresh, against a real Postgres.
 *
 * The interesting case is not "does it refresh" — it is what happens when two
 * workers reach an expiring account at the same moment. On a platform that
 * rotates refresh tokens, a lost race persists a token the platform has already
 * voided, and the account is locked out until someone reconnects it by hand.
 * That is a database-ordering guarantee, so it needs a database to test.
 *
 * Skipped when DATABASE_URL is unset, like the other integration suites.
 */

const url = process.env.DATABASE_URL;

/** Hands out a distinguishable token per call so races are attributable. */
function refreshingConnector(onRefresh?: () => void): {
  connector: Connector;
  calls: () => number;
} {
  let calls = 0;
  const connector = {
    meta: {
      id: "test-oauth",
      name: "Test",
      icon: "T",
      color: "#000",
      charLimit: 300,
      maxImages: 4,
      features: [],
    },
    auth: { kind: "oauth2", scopes: [] },
    validate: () => [],
    publish: async () => ({ externalId: "x", url: "x" }),
    reply: async () => ({ externalId: "x", url: "x" }),
    fetchEngagement: async () => ({ metrics: [], inbound: [] }),
    fetchProfile: async () => ({ externalId: "x", handle: "x", displayName: "x" }),
    async refreshCredentials(_: AccountCredentials): Promise<RefreshedCredentials> {
      const mine = ++calls;
      onRefresh?.();
      return {
        accessToken: `access-${mine}`,
        refreshToken: `refresh-${mine}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      };
    },
  } as unknown as Connector;
  return { connector, calls: () => calls };
}

describe("credential refresh", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `refresh-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;
  });

  after(async () => {
    if (workspaceId) {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    }
    await closeDatabase(db);
  });

  async function account(expiresAt: Date | null, withRefreshToken = true) {
    const vault = getTokenVault();
    const [row] = await db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId,
        connectorId: "test-oauth",
        handle: `refresh-${Date.now()}-${Math.random()}`,
        accessTokenEnc: vault.encrypt("access-original"),
        refreshTokenEnc: withRefreshToken ? vault.encrypt("refresh-original") : null,
        tokenExpiresAt: expiresAt,
      })
      .returning();
    return row!;
  }

  test("a token well before expiry is used as-is", async () => {
    const row = await account(new Date(Date.now() + 86_400_000));
    const { connector, calls } = refreshingConnector();

    const credentials = await credentialsFor(db, row, connector);

    assert.equal(calls(), 0, "should not have refreshed");
    assert.equal(credentials.accessToken, "access-original");
  });

  test("a token inside the skew window is refreshed and persisted", async () => {
    // Not yet expired, but close enough that a publish would race the clock.
    const row = await account(new Date(Date.now() + 60_000));
    const { connector, calls } = refreshingConnector();

    const credentials = await credentialsFor(db, row, connector);

    assert.equal(calls(), 1);
    assert.equal(credentials.accessToken, "access-1");

    const stored = await db.query.linkedAccounts.findFirst({
      where: eq(schema.linkedAccounts.id, row.id),
    });
    const vault = getTokenVault();
    assert.equal(vault.decrypt(stored!.accessTokenEnc!), "access-1");
    assert.equal(
      vault.decrypt(stored!.refreshTokenEnc!),
      "refresh-1",
      "a rotated refresh token must be stored too, or the next refresh fails",
    );
    assert.ok(stored!.tokenExpiresAt! > new Date(Date.now() + 3_000_000));
  });

  test("an account with no refresh token is never refreshed", async () => {
    // App passwords and non-expiring tokens: there is nothing to trade.
    const row = await account(new Date(Date.now() - 60_000), false);
    const { connector, calls } = refreshingConnector();

    await credentialsFor(db, row, connector);

    assert.equal(calls(), 0);
    assert.equal(needsRefresh(row), false);
  });

  test("a connector without the hook is left alone", async () => {
    const row = await account(new Date(Date.now() - 60_000));
    const { connector } = refreshingConnector();
    const noHook = { ...connector, refreshCredentials: undefined } as Connector;

    const credentials = await credentialsFor(db, row, noHook);

    assert.equal(credentials.accessToken, "access-original");
  });

  test("concurrent workers persist exactly one refresh, and agree on it", async () => {
    const row = await account(new Date(Date.now() + 60_000));

    // Hold every refresh until all of them are in flight, so the writes
    // genuinely collide instead of running one after another.
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    const WORKERS = 5;
    const { connector, calls } = refreshingConnector(() => {
      if (++inFlight === WORKERS) release();
    });
    const blocked = {
      ...connector,
      async refreshCredentials(credentials: AccountCredentials) {
        const result = await connector.refreshCredentials!(credentials);
        await gate;
        return result;
      },
    } as Connector;

    const results = await Promise.all(
      Array.from({ length: WORKERS }, () => credentialsFor(db, row, blocked)),
    );

    assert.equal(calls(), WORKERS, "each worker did attempt a refresh");

    const stored = await db.query.linkedAccounts.findFirst({
      where: eq(schema.linkedAccounts.id, row.id),
    });
    const persisted = getTokenVault().decrypt(stored!.accessTokenEnc!);

    // The guarantee: whoever lost re-read the winner's token rather than
    // carrying on with one the platform may already have invalidated.
    for (const credentials of results) {
      assert.equal(
        credentials.accessToken,
        persisted,
        "a losing worker must use the token that actually landed",
      );
    }
  });
});
