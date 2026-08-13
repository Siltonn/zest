import type { PostContent } from "@zest/shared";
import {
  validateAgainstMeta,
  type AccountCredentials,
  type Connector,
  type ConnectorMeta,
  type EngagementSnapshot,
  type NormalizedProfile,
  type PublishResult,
} from "./types.ts";

/**
 * Mastodon over the ActivityPub-backed REST API.
 *
 * Federated, so the instance URL is part of the credentials. Like Bluesky it
 * needs no platform approval — a self-hoster registers an app on their own
 * instance and is done.
 */

const meta: ConnectorMeta = {
  id: "mastodon",
  name: "Mastodon",
  icon: "🐘",
  color: "#6364ff",
  charLimit: 500,
  maxImages: 4,
  features: ["replies", "images", "threads", "polls"],
  setupHint:
    "Settings → Development → New application on your instance, with read and write scopes.",
};

async function mastodonFetch<T>(
  credentials: AccountCredentials,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const instance = credentials.endpoint;
  if (!instance) throw new Error("Mastodon requires an instance URL");

  const res = await fetch(`${instance}/api/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.accessToken ?? ""}`,
      ...init?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`Mastodon ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

type Status = {
  id: string;
  url: string;
  content: string;
  created_at: string;
  favourites_count?: number;
  reblogs_count?: number;
  replies_count?: number;
  in_reply_to_id?: string | null;
  account: { acct: string; display_name?: string; avatar?: string };
};

export const mastodonConnector: Connector = {
  meta,

  auth: {
    kind: "api_key",
    fields: [
      {
        name: "instance",
        label: "Instance URL",
        type: "url",
        placeholder: "https://mastodon.social",
        required: true,
      },
      {
        name: "accessToken",
        label: "Access token",
        type: "password",
        required: true,
      },
    ],
  },

  validate(content: PostContent) {
    return validateAgainstMeta(meta, content);
  },

  async publish(credentials, content): Promise<PublishResult> {
    const status = await mastodonFetch<Status>(credentials, "/statuses", {
      method: "POST",
      body: JSON.stringify({ status: content.text }),
    });
    return { externalId: status.id, url: status.url };
  },

  async reply(credentials, inReplyToExternalId, content): Promise<PublishResult> {
    const status = await mastodonFetch<Status>(credentials, "/statuses", {
      method: "POST",
      body: JSON.stringify({
        status: content.text,
        in_reply_to_id: inReplyToExternalId,
      }),
    });
    return { externalId: status.id, url: status.url };
  },

  async fetchEngagement(credentials, since): Promise<EngagementSnapshot> {
    const account = await mastodonFetch<{
      id: string;
      followers_count: number;
    }>(credentials, "/accounts/verify_credentials");

    const statuses = await mastodonFetch<Status[]>(
      credentials,
      `/accounts/${account.id}/statuses?limit=40`,
    );

    const metrics: EngagementSnapshot["metrics"] = [
      { metric: "followers", value: account.followers_count },
    ];
    for (const status of statuses) {
      if (new Date(status.created_at) < since) continue;
      metrics.push(
        { metric: "likes", value: status.favourites_count ?? 0, externalPostId: status.id },
        { metric: "reposts", value: status.reblogs_count ?? 0, externalPostId: status.id },
        { metric: "replies", value: status.replies_count ?? 0, externalPostId: status.id },
      );
    }

    const notifications = await mastodonFetch<
      {
        id: string;
        type: string;
        created_at: string;
        account: { acct: string; display_name?: string; avatar?: string };
        status?: Status;
      }[]
    >(credentials, "/notifications?limit=40&types[]=mention");

    const inbound: EngagementSnapshot["inbound"] = notifications
      .filter((n) => n.status && new Date(n.created_at) >= since)
      .map((n) => ({
        kind: n.status?.in_reply_to_id ? ("reply" as const) : ("mention" as const),
        externalId: n.status?.id ?? n.id,
        authorHandle: n.account.acct,
        authorName: n.account.display_name,
        authorAvatarUrl: n.account.avatar,
        // Mastodon returns HTML; the agent should reason over plain text.
        text: stripHtml(n.status?.content ?? ""),
        inReplyToExternalId: n.status?.in_reply_to_id ?? undefined,
        receivedAt: new Date(n.created_at),
      }));

    return { metrics, inbound };
  },

  async fetchProfile(credentials): Promise<NormalizedProfile> {
    const account = await mastodonFetch<{
      id: string;
      acct: string;
      display_name?: string;
      avatar?: string;
      url: string;
      followers_count: number;
    }>(credentials, "/accounts/verify_credentials");

    return {
      externalId: account.id,
      handle: account.acct,
      displayName: account.display_name || account.acct,
      avatarUrl: account.avatar,
      profileUrl: account.url,
      followerCount: account.followers_count,
    };
  },

  async connectWithFields(fields) {
    const instance = (fields.instance ?? "").replace(/\/$/, "");
    const credentials: AccountCredentials = {
      accountId: "",
      handle: "",
      accessToken: fields.accessToken ?? "",
      endpoint: instance,
    };
    const profile = await mastodonConnector.fetchProfile(credentials);
    return {
      credentials: {
        accessToken: fields.accessToken ?? "",
        endpoint: instance,
        externalId: profile.externalId,
      },
      profile,
    };
  },
};

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
