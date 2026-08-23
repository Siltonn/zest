import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { schema } from "@zest/db";

/**
 * The parts of the Better Auth config that describe *shape* rather than
 * *deployment*: which tables back which models, and which plugins are on.
 *
 * Split out of `auth.ts` because `auth-schema.spec.ts` needs them and nothing
 * else: no environment, no database, no `loadEnv()`. (Also literally — the
 * test runner strips types rather than compiling, so a spec cannot reach
 * through a module that imports `../config.js`.)
 */

/**
 * Better Auth model name → the Drizzle table that backs it.
 *
 * Better Auth does not create tables. It only declares the fields it expects,
 * and its CLI can apply them directly only through the built-in Kysely
 * adapter — with Drizzle the schema has to live in this repo either way. So it
 * is hand-written in `@zest/db` alongside every other table, in this repo's
 * conventions: plural, snake_case, timestamptz, one migration history. This
 * map is the adapter's bridge between those names and Better Auth's.
 *
 * Hand-written means it can drift from what the library asks for, which is why
 * `auth-schema.spec.ts` diffs the two on every test run.
 */
export const authSchemaMap = {
  user: schema.users,
  session: schema.sessions,
  account: schema.accounts,
  verification: schema.verifications,
  jwks: schema.jwks,
  oauthClient: schema.oauthClients,
  oauthResource: schema.oauthResources,
  oauthClientResource: schema.oauthClientResources,
  oauthRefreshToken: schema.oauthRefreshTokens,
  oauthAccessToken: schema.oauthAccessTokens,
  oauthConsent: schema.oauthConsents,
  oauthClientAssertion: schema.oauthClientAssertions,
};

/** RFC 8707 resource identifier — the MCP endpoint itself. */
export const mcpResource = (baseURL: string): string => `${baseURL}/mcp`;

/**
 * No return type annotation on purpose: Better Auth derives `auth.api` from
 * the plugin types, so widening this to `BetterAuthPlugin[]` would erase the
 * OAuth endpoints from the `Auth` type.
 */
export function authPlugins(baseURL: string) {
  return [
    // Access tokens are signed JWTs, so the provider needs a key pair. This
    // plugin owns it (the `jwks` table) and publishes the public half at
    // /api/auth/jwks, which is where /mcp verifies every token against.
    jwt(),
    mcp({
      // Both are pages in the web app, not API routes. Better Auth hands each
      // one the whole authorization request as a signed query string and takes
      // it back the same way, so neither page has to park state anywhere.
      loginPage: "/authorize",
      consentPage: "/authorize",
      resource: mcpResource(baseURL),
      // MCP clients arrive unannounced: Claude registers itself the first time
      // someone adds this server as a connector, with nobody signed in on the
      // registration request. Turning both of these off would mean every
      // client had to be provisioned by hand.
      //
      // What keeps that safe is the consent screen, which 1.7 requires by
      // default: an unknown client can register, but it cannot get a token
      // until a signed-in operator looks at where the token is going and
      // clicks Authorize.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
    }),
  ];
}
