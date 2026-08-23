import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { mcp } from "better-auth/plugins";
import { schema, type Database } from "@zest/db";
import { loadEnv, publicBaseUrl } from "../config.js";

/** Injection token lives here so guards can import it without the module. */
export const AUTH = Symbol("AUTH");

/**
 * Better Auth, mounted on the backend rather than the Next.js app so the
 * frontend stays a pure client. Self-hostable, no third-party identity service.
 *
 * The `mcp` plugin makes this instance an OAuth 2.1 authorization server for
 * MCP clients: RFC 7591 dynamic client registration at `/api/auth/mcp/register`,
 * the authorization-code + PKCE flow at `/api/auth/mcp/authorize` and
 * `/api/auth/mcp/token`, and the metadata documents that
 * `/.well-known/oauth-authorization-server` and
 * `/.well-known/oauth-protected-resource` serve. Claude (or any MCP client)
 * discovers all of it from a single 401 challenge on `/mcp` — no manual client
 * setup. Tokens are opaque rows in `oauth_access_tokens`, each tied to the user
 * who approved the flow, which is what lets an MCP session act with that
 * user's authority.
 */
export function createAuth(db: Database) {
  const env = loadEnv();
  const baseURL = publicBaseUrl(env);

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        oauthApplication: schema.oauthApplications,
        oauthAccessToken: schema.oauthAccessTokens,
        oauthConsent: schema.oauthConsents,
      },
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL,
    basePath: "/api/auth",
    trustedOrigins: [env.WEB_URL],
    emailAndPassword: {
      enabled: true,
      // Nobody is going to click a verification link in a local demo.
      requireEmailVerification: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    plugins: [
      mcp({
        // A web page, not an API route: it signs the operator in (or confirms
        // the session) and then resumes the authorization request. Relative,
        // so it resolves against whichever origin the flow is riding on.
        loginPage: "/authorize",
        // RFC 9728 resource identifier — the MCP endpoint itself.
        resource: `${baseURL}/mcp`,
        oidcConfig: {
          // The plugin overrides this with the outer loginPage; the type wants
          // it here regardless.
          loginPage: "/authorize",
          // MCP clients are public clients; PKCE is what stands in for a secret.
          requirePKCE: true,
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
