/**
 * Thin client over the backend REST API.
 *
 * The browser talks to a same-origin path that Next rewrites to the NestJS
 * service, so cookies ride along and there is no CORS to configure.
 */

const BASE = "/api/v1";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "include",
  });

  if (!res.ok) {
    // Nest returns { message, error, statusCode }. Surfacing the raw body puts
    // JSON in front of the user; the message is the part written for them.
    const body = await res.text();
    let message = body || `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(body) as { message?: string | string[] };
      if (parsed.message) {
        message = Array.isArray(parsed.message)
          ? parsed.message.join("; ")
          : parsed.message;
      }
    } catch {
      // Not JSON — the raw text is the best we have.
    }
    throw new Error(message);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// ── Types mirrored from the backend ──────────────────────────────────────

export type PostStatus =
  | "draft"
  | "pending_approval"
  | "needs_changes"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "rejected"
  | "expired"
  | "canceled";

export type Actor =
  | { kind: "human"; userId: string }
  | { kind: "agent"; runId: string; role?: string }
  | { kind: "system"; source: string }
  | { kind: "mcp"; clientId: string }
  | { kind: "api"; keyId: string };

export type AuditEntry = {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: Actor;
  diff: unknown;
  agentRunId: string | null;
  createdAt: string;
};

export type Account = {
  id: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  connectorId: string;
  platform: {
    name: string;
    icon: string;
    color: string;
    charLimit: number;
    maxImages: number;
    features: string[];
  } | null;
};

export type Post = {
  id: string;
  status: PostStatus;
  /** Set when this is an evergreen re-run of an earlier post. */
  recycledFromId?: string | null;
  content: {
    text: string;
    media: { url: string; altText?: string }[];
    /** Follow-up thread parts, text-only. */
    thread?: string[];
  };
  suggestedSlotAt: string | null;
  scheduledAt: string | null;
  publishedAt: string | null;
  externalUrl: string | null;
  errorMessage: string | null;
  reasoning: string | null;
  createdByActor: Actor;
  agentRunId: string | null;
  createdAt: string;
  account: Account;
  timeline?: AuditEntry[];
};

export type InboxItem = {
  id: string;
  kind: "post" | "reply" | "memory" | "autonomy_request" | "plan";
  title: string;
  body: string;
  accountHandle?: string;
  connectorId?: string;
  suggestedSlotAt: string | null;
  reasoning: string | null;
  agentRunId: string | null;
  createdAt: string;
  context?: { author: string; text: string; sentiment?: string | null };
  /** Posts only: follow-up thread parts. */
  threadParts?: string[];
  /** Memory proposals only: the document as it stands, for the diff. */
  before?: string | null;
  /** Plan cards only: the topics waiting to be written. */
  planItems?: {
    id: string;
    topic: string;
    angle: string | null;
    accountHandle: string;
    suggestedSlotAt: string | null;
  }[];
};

export type OnboardingStep = {
  id: string;
  title: string;
  description: string;
  href: string;
  cta: string;
  done: boolean;
};

export type OnboardingState = {
  complete: boolean;
  doneCount: number;
  steps: OnboardingStep[];
};

export type AnalyticsResponse = {
  summary: {
    impressions: number;
    likes: number;
    reposts: number;
    replies: number;
    followers: number;
    engagementRate: number;
    postCount: number;
  };
  topPosts: {
    postId: string;
    text: string;
    accountHandle: string;
    impressions: number;
    engagementRate: number;
  }[];
  series: {
    impressions: { date: string; value: number }[];
    followers: { date: string; value: number }[];
  };
};

export type MemoryDoc = {
  id: string;
  kind: string;
  version: number;
  contentMd: string;
  updatedByActor: Actor;
  createdAt: string;
};

export type AutonomyRule = {
  id: string;
  action: string;
  connectorId: string | null;
  accountId: string | null;
  mode: "approve" | "auto";
  conditions: { sentiment?: string; maxPerDay?: number } | null;
  grantedAt: string;
};

export type TrustStat = {
  action: string;
  approved: number;
  editedOrRejected: number;
  consecutiveCleanApprovals: number;
  readyToGraduate: boolean;
};

export type AgentRun = {
  id: string;
  role: string | null;
  /** Which programme this stage served, and the account it wrote for. */
  planId: string | null;
  accountId: string | null;
  /** Ties the stages of one planning cycle together. */
  cycleId: string | null;
  output: string | null;
  trigger: string;
  status: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  transcript: unknown[];
  errorMessage: string | null;
  startedAt: string;
  endedAt: string | null;
};

export type PomeloPost = {
  id: string;
  text: string;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  impressions: number;
  createdAt: string;
  author: {
    handle: string;
    displayName: string;
    avatarUrl: string;
    isPersona: boolean;
  };
};

export type Workspace = {
  id: string;
  name: string;
  timezone: string;
  kpiConfig: { goal?: string } | null;
  simNow: string;
};
