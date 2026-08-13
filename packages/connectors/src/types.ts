import type { PostContent } from "@zest/shared";

/**
 * The platform plugin contract.
 *
 * Pomelo — the simulated network — implements this exactly like Bluesky does,
 * and talks over real HTTP rather than in-process calls. So the offline demo
 * exercises the same publish/ingest path a production integration takes, and a
 * bug in that path shows up locally instead of only against a live account.
 */

export type ConnectorFeature = "replies" | "threads" | "images" | "polls" | "dm";

export type ConnectorMeta = {
  id: string;
  name: string;
  /** Emoji or short glyph; the UI does not ship per-platform logo assets. */
  icon: string;
  color: string;
  charLimit: number;
  maxImages: number;
  features: ConnectorFeature[];
  /** Shown on the connect screen when credentials are needed. */
  setupHint?: string;
};

export type FieldSpec = {
  name: string;
  label: string;
  type: "text" | "password" | "url";
  placeholder?: string;
  required: boolean;
};

export type ConnectorAuth =
  | { kind: "oauth2"; scopes: string[] }
  | { kind: "app_password"; fields: FieldSpec[] }
  | { kind: "api_key"; fields: FieldSpec[] };

/** What a connector receives to act on behalf of an account. */
export type AccountCredentials = {
  accountId: string;
  handle: string;
  externalId?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  /** Instance URL for federated platforms (Mastodon), API base for Pomelo. */
  endpoint?: string | null;
};

export type ValidationIssue = {
  field: "text" | "media";
  message: string;
  severity: "error" | "warning";
};

export type PublishResult = {
  externalId: string;
  url: string;
};

export type MetricSample = {
  metric: "impressions" | "likes" | "reposts" | "replies" | "followers";
  value: number;
  postId?: string;
  externalPostId?: string;
  at?: Date;
};

export type InboundMessage = {
  kind: "reply" | "mention" | "dm";
  externalId: string;
  authorHandle: string;
  authorName?: string;
  authorAvatarUrl?: string;
  text: string;
  /** The platform post this is replying to, so we can link it back. */
  inReplyToExternalId?: string;
  receivedAt: Date;
};

export type EngagementSnapshot = {
  metrics: MetricSample[];
  inbound: InboundMessage[];
};

export type NormalizedProfile = {
  externalId: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  profileUrl?: string;
  followerCount?: number;
};

export interface Connector {
  readonly meta: ConnectorMeta;
  readonly auth: ConnectorAuth;

  /** Pure, no network: powers live character counts and pre-publish checks. */
  validate(content: PostContent): ValidationIssue[];

  publish(credentials: AccountCredentials, content: PostContent): Promise<PublishResult>;

  reply(
    credentials: AccountCredentials,
    inReplyToExternalId: string,
    content: PostContent,
  ): Promise<PublishResult>;

  fetchEngagement(
    credentials: AccountCredentials,
    since: Date,
  ): Promise<EngagementSnapshot>;

  fetchProfile(credentials: AccountCredentials): Promise<NormalizedProfile>;

  /** Optional: only some platforms allow programmatic DMs. */
  sendDm?(
    credentials: AccountCredentials,
    targetHandle: string,
    content: PostContent,
  ): Promise<void>;

  /** Exchange user-entered fields for stored credentials (non-OAuth flows). */
  connectWithFields?(
    fields: Record<string, string>,
  ): Promise<{ credentials: Partial<AccountCredentials>; profile: NormalizedProfile }>;
}

/** Shared text validation so every connector reports limits the same way. */
export function validateAgainstMeta(
  meta: ConnectorMeta,
  content: PostContent,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const length = [...content.text].length;

  if (length === 0) {
    issues.push({ field: "text", message: "Post is empty", severity: "error" });
  }
  if (length > meta.charLimit) {
    issues.push({
      field: "text",
      message: `${length} characters — ${meta.name} allows ${meta.charLimit}`,
      severity: "error",
    });
  } else if (length > meta.charLimit * 0.9) {
    issues.push({
      field: "text",
      message: `${meta.charLimit - length} characters left`,
      severity: "warning",
    });
  }
  if (content.media.length > meta.maxImages) {
    issues.push({
      field: "media",
      message: `${meta.name} accepts at most ${meta.maxImages} images`,
      severity: "error",
    });
  }
  if (!meta.features.includes("images") && content.media.length > 0) {
    issues.push({
      field: "media",
      message: `${meta.name} does not support images`,
      severity: "error",
    });
  }
  return issues;
}
