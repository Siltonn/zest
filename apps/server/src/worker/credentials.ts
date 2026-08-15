import { and, eq, isNull, schema, type Database } from "@zest/db";
import { getTokenVault } from "@zest/shared";
import type { AccountCredentials, Connector } from "@zest/connectors";

/**
 * Turns a stored account row into credentials a connector can use, decrypting
 * tokens at the last possible moment. Nothing upstream of here ever holds
 * plaintext.
 */
export function toCredentials(
  account: typeof schema.linkedAccounts.$inferSelect,
): AccountCredentials {
  const vault = getTokenVault();
  return {
    accountId: account.id,
    handle: account.handle,
    externalId: account.externalId,
    accessToken: account.accessTokenEnc ? vault.decrypt(account.accessTokenEnc) : null,
    refreshToken: account.refreshTokenEnc
      ? vault.decrypt(account.refreshTokenEnc)
      : null,
    endpoint: account.endpoint,
  };
}

/**
 * Refresh a token before it expires rather than after it fails.
 *
 * Waiting for a 401 sounds simpler and is worse: the failure surfaces as a
 * failed publish on a post the operator already approved, at the scheduled
 * minute, which is the one moment the system is supposed to be unattended.
 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function needsRefresh(
  account: typeof schema.linkedAccounts.$inferSelect,
  now = new Date(),
): boolean {
  if (!account.refreshTokenEnc || !account.tokenExpiresAt) return false;
  return account.tokenExpiresAt.getTime() - now.getTime() <= REFRESH_SKEW_MS;
}

/**
 * Credentials for a connector, refreshed first if they are about to expire.
 *
 * Every publish and ingest path goes through here, so a connector that
 * implements `refreshCredentials` gets refresh handling on all of them without
 * either side knowing about the other.
 *
 * Two workers can reach an expiring account at the same moment, and on
 * platforms that rotate refresh tokens the loser of that race would persist a
 * token the platform has already invalidated — locking the account out until
 * someone reconnects it by hand. The write is therefore conditional on
 * `tokenExpiresAt` still holding the value we read: exactly one refresh lands,
 * and the other re-reads and uses the winner's token. Same shape as the publish
 * claim, for the same reason — the guarantee belongs in the database, not in
 * the hope that two jobs never overlap.
 */
export async function credentialsFor(
  db: Database,
  account: typeof schema.linkedAccounts.$inferSelect,
  connector: Connector,
): Promise<AccountCredentials> {
  if (!connector.refreshCredentials || !needsRefresh(account)) {
    return toCredentials(account);
  }

  const refreshed = await connector.refreshCredentials(toCredentials(account));
  const vault = getTokenVault();

  const [won] = await db
    .update(schema.linkedAccounts)
    .set({
      ...(refreshed.accessToken
        ? { accessTokenEnc: vault.encrypt(refreshed.accessToken) }
        : {}),
      ...(refreshed.refreshToken
        ? { refreshTokenEnc: vault.encrypt(refreshed.refreshToken) }
        : {}),
      ...(refreshed.expiresAt ? { tokenExpiresAt: refreshed.expiresAt } : {}),
    })
    .where(
      and(
        eq(schema.linkedAccounts.id, account.id),
        // `eq` on a null column matches nothing, so the two cases split.
        account.tokenExpiresAt
          ? eq(schema.linkedAccounts.tokenExpiresAt, account.tokenExpiresAt)
          : isNull(schema.linkedAccounts.tokenExpiresAt),
      ),
    )
    .returning();

  if (won) return toCredentials(won);

  // Someone else refreshed while we were in flight. Their token is the live
  // one; ours may already be void.
  const current = await db.query.linkedAccounts.findFirst({
    where: eq(schema.linkedAccounts.id, account.id),
  });
  return toCredentials(current ?? account);
}
