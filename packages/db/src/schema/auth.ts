import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Better Auth owns these tables; shapes follow its Drizzle adapter. */

export const users = pgTable("users", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text().notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  ipAddress: text(),
  userAgent: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text().notNull(),
  providerId: text().notNull(),
  accessToken: text(),
  refreshToken: text(),
  accessTokenExpiresAt: timestamp({ withTimezone: true }),
  refreshTokenExpiresAt: timestamp({ withTimezone: true }),
  scope: text(),
  idToken: text(),
  password: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * OAuth provider tables for Better Auth's `mcp` plugin.
 *
 * Zest's MCP endpoint is an OAuth 2.1 resource server: an MCP client (Claude,
 * an IDE) discovers these through `/.well-known/oauth-protected-resource`,
 * registers itself here (RFC 7591 dynamic client registration), sends the
 * operator through the normal sign-in, and ends up with an access token that
 * acts *as that user*. Rows here are what make a token traceable to a person —
 * which is exactly what granting autonomy requires.
 */

export const oauthApplications = pgTable("oauth_applications", {
  id: text().primaryKey(),
  /** Dynamic registration may omit `client_name`, so this stays nullable. */
  name: text(),
  icon: text(),
  metadata: text(),
  clientId: text().notNull().unique(),
  clientSecret: text(),
  redirectUrls: text().notNull(),
  type: text().notNull(),
  disabled: boolean().notNull().default(false),
  /** Null for anonymously registered clients — the normal DCR case. */
  userId: text().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: text().primaryKey(),
    accessToken: text().notNull().unique(),
    refreshToken: text().notNull().unique(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }).notNull(),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }).notNull(),
    clientId: text()
      .notNull()
      .references(() => oauthApplications.clientId, { onDelete: "cascade" }),
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    scopes: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("oauth_access_tokens_user_idx").on(t.userId)],
);

export const oauthConsents = pgTable("oauth_consents", {
  id: text().primaryKey(),
  clientId: text()
    .notNull()
    .references(() => oauthApplications.clientId, { onDelete: "cascade" }),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  scopes: text().notNull(),
  consentGiven: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Membership joins Better Auth users to Zest workspaces. */
export const memberships = pgTable("memberships", {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid().notNull(),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: text().notNull().default("owner"),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
