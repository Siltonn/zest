import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Better Auth owns these tables; shapes follow its Drizzle adapter.
 *
 * Better Auth never runs DDL — it declares the fields it expects and leaves
 * the tables to you, so these are written by hand in this repo's conventions
 * (plural, snake_case, timestamptz) rather than generated. What keeps them
 * honest is `apps/server/src/auth/auth-schema.spec.ts`, which diffs every
 * column here against `getAuthTables()` on each test run.
 *
 * Two conventions come from the library's own Postgres type map rather than
 * from us: `date` fields are timestamptz, and both `string[]` and `json`
 * fields are `jsonb` — arrays are stored as JSON arrays, not `text[]`.
 */

export const users = pgTable("users", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
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
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Who vouched for this account, as an issuer identifier. Email/password
     * accounts get `local:credential`; a social provider would put its own
     * issuer URL here. Added in Better Auth 1.7 so an account is keyed by
     * (issuer, accountId) rather than by provider name alone.
     */
    issuer: text().notNull(),
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
  },
  (t) => [index("accounts_user_idx").on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  // Every token lookup — email verification, password reset, and the parked
  // OAuth authorization the MCP flow stores here — finds rows by identifier.
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

/**
 * Signing keys for the tokens the OAuth provider issues.
 *
 * MCP access tokens are JWTs now, not opaque rows, so `/mcp` verifies a
 * signature instead of doing a database lookup. The private key is encrypted
 * by Better Auth before it lands here; the public half is what
 * `/api/auth/jwks` publishes.
 */
export const jwks = pgTable("jwks", {
  id: text().primaryKey(),
  publicKey: text().notNull(),
  privateKey: text().notNull(),
  alg: text(),
  crv: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp({ withTimezone: true }),
});

/**
 * OAuth provider tables, for `@better-auth/mcp`.
 *
 * Zest's MCP endpoint is an OAuth 2.1 protected resource: an MCP client
 * (Claude, an IDE) discovers it through `/.well-known/oauth-protected-resource`,
 * registers itself (RFC 7591 dynamic client registration), sends the operator
 * through sign-in and an explicit consent screen, and ends up with an access
 * token that acts *as that user*. Rows here are what make a token traceable to
 * a person — which is exactly what granting autonomy requires.
 *
 * `oauth_resources` is unusual in that the server seeds it at boot: the MCP
 * plugin registers its own `resource` identifier there on startup, so tokens
 * can be audience-bound to `<public-url>/mcp`.
 */

export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: text().primaryKey(),
    clientId: text().notNull().unique(),
    clientSecret: text(),
    clientDiscoveryId: text(),
    disabled: boolean().default(false),
    /** Set per client to bypass the consent screen. Never set by Zest. */
    skipConsent: boolean(),
    enableEndSession: boolean(),
    subjectType: text(),
    scopes: jsonb().$type<string[]>(),
    clientCredentialsScopes: jsonb().$type<string[]>(),
    /** Null for anonymously registered clients — the normal DCR case. */
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    name: text(),
    uri: text(),
    icon: text(),
    contacts: jsonb().$type<string[]>(),
    tos: text(),
    policy: text(),
    softwareId: text(),
    softwareVersion: text(),
    softwareStatement: text(),
    redirectUris: jsonb().$type<string[]>().notNull(),
    postLogoutRedirectUris: jsonb().$type<string[]>(),
    backchannelLogoutUri: text(),
    backchannelLogoutSessionRequired: boolean(),
    tokenEndpointAuthMethod: text(),
    applicationType: text(),
    jwks: text(),
    jwksUri: text(),
    grantTypes: jsonb().$type<string[]>(),
    responseTypes: jsonb().$type<string[]>(),
    requirePKCE: boolean(),
    dpopBoundAccessTokens: boolean().default(false),
    referenceId: text(),
    metadata: jsonb(),
    createdAt: timestamp({ withTimezone: true }).defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow(),
  },
  (t) => [index("oauth_clients_user_idx").on(t.userId)],
);

export const oauthResources = pgTable("oauth_resources", {
  id: text().primaryKey(),
  identifier: text().notNull().unique(),
  name: text().notNull(),
  accessTokenTtl: integer(),
  refreshTokenTtl: integer(),
  signingAlgorithm: text(),
  signingKeyId: text(),
  allowedScopes: jsonb().$type<string[]>(),
  customClaims: jsonb(),
  dpopBoundAccessTokensRequired: boolean().default(false),
  disabled: boolean().default(false),
  policyVersion: integer().default(0),
  metadata: jsonb(),
  createdAt: timestamp({ withTimezone: true }).defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow(),
});

export const oauthClientResources = pgTable(
  "oauth_client_resources",
  {
    id: text().primaryKey(),
    clientId: text()
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    resourceId: text()
      .notNull()
      .references(() => oauthResources.identifier, { onDelete: "cascade" }),
    metadata: jsonb(),
    createdAt: timestamp({ withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("oauth_client_resources_client_idx").on(t.clientId),
    index("oauth_client_resources_resource_idx").on(t.resourceId),
  ],
);

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text()
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text().references(() => sessions.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: jsonb().$type<string[]>(),
    requestedUserInfoClaims: jsonb().$type<string[]>(),
    scopes: jsonb().$type<string[]>().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revoked: timestamp({ withTimezone: true }),
    rotatedAt: timestamp({ withTimezone: true }),
    // A retried refresh inside the reuse window replays this stored response
    // instead of failing as a rotation replay.
    rotationReplayResponse: text(),
    rotationReplayExpiresAt: timestamp({ withTimezone: true }),
    authTime: timestamp({ withTimezone: true }),
    confirmation: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("oauth_refresh_tokens_client_idx").on(t.clientId),
    index("oauth_refresh_tokens_session_idx").on(t.sessionId),
    index("oauth_refresh_tokens_user_idx").on(t.userId),
    index("oauth_refresh_tokens_code_idx").on(t.authorizationCodeId),
  ],
);

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text()
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text().references(() => sessions.id, { onDelete: "cascade" }),
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: jsonb().$type<string[]>(),
    requestedUserInfoClaims: jsonb().$type<string[]>(),
    refreshId: text(),
    scopes: jsonb().$type<string[]>().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revoked: timestamp({ withTimezone: true }),
    confirmation: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("oauth_access_tokens_client_idx").on(t.clientId),
    index("oauth_access_tokens_session_idx").on(t.sessionId),
    index("oauth_access_tokens_user_idx").on(t.userId),
    index("oauth_access_tokens_code_idx").on(t.authorizationCodeId),
    index("oauth_access_tokens_refresh_idx").on(t.refreshId),
  ],
);

export const oauthConsents = pgTable(
  "oauth_consents",
  {
    id: text().primaryKey(),
    clientId: text()
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    referenceId: text(),
    resources: jsonb().$type<string[]>(),
    requestedUserInfoClaims: jsonb().$type<string[]>(),
    scopes: jsonb().$type<string[]>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("oauth_consents_client_idx").on(t.clientId),
    index("oauth_consents_user_idx").on(t.userId),
  ],
);

/**
 * Spent `private_key_jwt` client assertions, kept until they expire so the
 * same one cannot be replayed. The id is the assertion's `jti`.
 */
export const oauthClientAssertions = pgTable("oauth_client_assertions", {
  id: text().primaryKey(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
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
