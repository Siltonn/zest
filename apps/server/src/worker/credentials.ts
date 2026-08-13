import { schema } from "@zest/db";
import { getTokenVault } from "@zest/shared";
import type { AccountCredentials } from "@zest/connectors";

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
