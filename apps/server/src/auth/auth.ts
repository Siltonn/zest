import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { schema, type Database } from "@zest/db";
import { loadEnv } from "../config.js";

/** Injection token lives here so guards can import it without the module. */
export const AUTH = Symbol("AUTH");

/**
 * Better Auth, mounted on the backend rather than the Next.js app so the
 * frontend stays a pure client. Self-hostable, no third-party identity service.
 */
export function createAuth(db: Database) {
  const env = loadEnv();

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
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
  });
}

export type Auth = ReturnType<typeof createAuth>;
