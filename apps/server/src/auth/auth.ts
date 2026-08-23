import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Database } from "@zest/db";
import { loadEnv, publicBaseUrl } from "../config.js";
import { authPlugins, authSchemaMap } from "./auth.options.js";

/** Injection token lives here so guards can import it without the module. */
export const AUTH = Symbol("AUTH");

/**
 * Better Auth, mounted on the backend rather than the Next.js app so the
 * frontend stays a pure client. Self-hostable, no third-party identity service.
 *
 * The `mcp` plugin makes this instance an OAuth 2.1 authorization server for
 * MCP clients: RFC 7591 dynamic client registration at
 * `/api/auth/oauth2/register`, the authorization-code + PKCE flow at
 * `/api/auth/oauth2/authorize` and `/api/auth/oauth2/token`, and the metadata
 * documents that `/.well-known/oauth-authorization-server` and
 * `/.well-known/oauth-protected-resource` serve. Claude (or any MCP client)
 * discovers all of it from a single 401 challenge on `/mcp` — no manual client
 * setup. Access tokens are JWTs signed with the key pair in `jwks` and bound
 * to `<public-url>/mcp` as audience; each carries the id of the user who
 * approved the flow, which is what lets an MCP session act with that user's
 * authority.
 *
 * The table map and the plugin list live in `auth.options.ts`, where a test can
 * read them without an environment. Everything left here is deployment.
 */
export function createAuth(db: Database) {
  const env = loadEnv();
  const baseURL = publicBaseUrl(env);

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: authSchemaMap,
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
    plugins: authPlugins(baseURL),
  });
}

export type Auth = ReturnType<typeof createAuth>;
