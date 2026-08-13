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
 * Bluesky over the AT Protocol.
 *
 * The easiest real platform to support and therefore the first one: app
 * passwords mean a self-hoster needs no developer account, no app review, and
 * no per-post billing — they paste a password and publish.
 */

const meta: ConnectorMeta = {
  id: "bluesky",
  name: "Bluesky",
  icon: "🦋",
  color: "#0085ff",
  charLimit: 300,
  maxImages: 4,
  features: ["replies", "images", "threads"],
  setupHint:
    "Create an app password at Settings → Privacy and security → App passwords.",
};

const DEFAULT_SERVICE = "https://bsky.social";

function service(credentials: AccountCredentials): string {
  return credentials.endpoint ?? DEFAULT_SERVICE;
}

type Session = { accessJwt: string; did: string; handle: string };

async function createSession(
  serviceUrl: string,
  identifier: string,
  password: string,
): Promise<Session> {
  const res = await fetch(`${serviceUrl}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  if (!res.ok) {
    throw new Error(`Bluesky sign-in failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as Session;
}

/**
 * App-password sessions are short-lived, so we mint one per operation rather
 * than storing a JWT that expires between a post being scheduled and published.
 */
async function withSession<T>(
  credentials: AccountCredentials,
  fn: (session: Session, serviceUrl: string) => Promise<T>,
): Promise<T> {
  const serviceUrl = service(credentials);
  const session = await createSession(
    serviceUrl,
    credentials.handle,
    credentials.accessToken ?? "",
  );
  return fn(session, serviceUrl);
}

async function createRecord(
  session: Session,
  serviceUrl: string,
  record: Record<string, unknown>,
): Promise<{ uri: string; cid: string }> {
  const res = await fetch(`${serviceUrl}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record: { $type: "app.bsky.feed.post", createdAt: new Date().toISOString(), ...record },
    }),
  });
  if (!res.ok) {
    throw new Error(`Bluesky post failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { uri: string; cid: string };
}

/** at://did/collection/rkey → the web permalink a human can open. */
function permalink(handle: string, uri: string): string {
  const rkey = uri.split("/").pop() ?? "";
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

export const blueskyConnector: Connector = {
  meta,

  auth: {
    kind: "app_password",
    fields: [
      {
        name: "handle",
        label: "Handle",
        type: "text",
        placeholder: "you.bsky.social",
        required: true,
      },
      {
        name: "appPassword",
        label: "App password",
        type: "password",
        placeholder: "xxxx-xxxx-xxxx-xxxx",
        required: true,
      },
      {
        name: "service",
        label: "PDS URL",
        type: "url",
        placeholder: DEFAULT_SERVICE,
        required: false,
      },
    ],
  },

  validate(content: PostContent) {
    return validateAgainstMeta(meta, content);
  },

  async publish(credentials, content): Promise<PublishResult> {
    return withSession(credentials, async (session, serviceUrl) => {
      const created = await createRecord(session, serviceUrl, { text: content.text });
      return {
        externalId: created.uri,
        url: permalink(session.handle, created.uri),
      };
    });
  },

  async reply(credentials, inReplyToExternalId, content): Promise<PublishResult> {
    return withSession(credentials, async (session, serviceUrl) => {
      // AT Protocol replies carry both the immediate parent and the thread root.
      const parent = { uri: inReplyToExternalId, cid: "" };
      const created = await createRecord(session, serviceUrl, {
        text: content.text,
        reply: { root: parent, parent },
      });
      return {
        externalId: created.uri,
        url: permalink(session.handle, created.uri),
      };
    });
  },

  async fetchEngagement(credentials, since): Promise<EngagementSnapshot> {
    return withSession(credentials, async (session, serviceUrl) => {
      const headers = { Authorization: `Bearer ${session.accessJwt}` };

      const feedRes = await fetch(
        `${serviceUrl}/xrpc/app.bsky.feed.getAuthorFeed?actor=${session.did}&limit=50`,
        { headers },
      );
      const feed = feedRes.ok
        ? ((await feedRes.json()) as {
            feed: {
              post: {
                uri: string;
                likeCount?: number;
                repostCount?: number;
                replyCount?: number;
                indexedAt: string;
              };
            }[];
          })
        : { feed: [] };

      const metrics: EngagementSnapshot["metrics"] = [];
      for (const item of feed.feed) {
        if (new Date(item.post.indexedAt) < since) continue;
        metrics.push(
          { metric: "likes", value: item.post.likeCount ?? 0, externalPostId: item.post.uri },
          { metric: "reposts", value: item.post.repostCount ?? 0, externalPostId: item.post.uri },
          { metric: "replies", value: item.post.replyCount ?? 0, externalPostId: item.post.uri },
        );
      }

      const profileRes = await fetch(
        `${serviceUrl}/xrpc/app.bsky.actor.getProfile?actor=${session.did}`,
        { headers },
      );
      if (profileRes.ok) {
        const profile = (await profileRes.json()) as { followersCount?: number };
        metrics.push({ metric: "followers", value: profile.followersCount ?? 0 });
      }

      const notifRes = await fetch(
        `${serviceUrl}/xrpc/app.bsky.notification.listNotifications?limit=50`,
        { headers },
      );
      const inbound: EngagementSnapshot["inbound"] = [];
      if (notifRes.ok) {
        const notifications = (await notifRes.json()) as {
          notifications: {
            uri: string;
            reason: string;
            author: { handle: string; displayName?: string; avatar?: string };
            record: { text?: string; reply?: { parent?: { uri?: string } } };
            indexedAt: string;
          }[];
        };
        for (const n of notifications.notifications) {
          if (n.reason !== "reply" && n.reason !== "mention") continue;
          if (new Date(n.indexedAt) < since) continue;
          inbound.push({
            kind: n.reason === "reply" ? "reply" : "mention",
            externalId: n.uri,
            authorHandle: n.author.handle,
            authorName: n.author.displayName,
            authorAvatarUrl: n.author.avatar,
            text: n.record.text ?? "",
            inReplyToExternalId: n.record.reply?.parent?.uri,
            receivedAt: new Date(n.indexedAt),
          });
        }
      }

      return { metrics, inbound };
    });
  },

  async fetchProfile(credentials): Promise<NormalizedProfile> {
    return withSession(credentials, async (session, serviceUrl) => {
      const res = await fetch(
        `${serviceUrl}/xrpc/app.bsky.actor.getProfile?actor=${session.did}`,
        { headers: { Authorization: `Bearer ${session.accessJwt}` } },
      );
      const profile = res.ok
        ? ((await res.json()) as {
            displayName?: string;
            avatar?: string;
            followersCount?: number;
          })
        : {};
      return {
        externalId: session.did,
        handle: session.handle,
        displayName: profile.displayName ?? session.handle,
        avatarUrl: profile.avatar,
        profileUrl: `https://bsky.app/profile/${session.handle}`,
        followerCount: profile.followersCount,
      };
    });
  },

  async connectWithFields(fields) {
    const serviceUrl = fields.service?.trim() || DEFAULT_SERVICE;
    const handle = fields.handle ?? "";
    const password = fields.appPassword ?? "";
    // Sign in once during setup so a bad password is reported here rather than
    // silently at publish time, hours later.
    const session = await createSession(serviceUrl, handle, password);
    const profile = await blueskyConnector.fetchProfile({
      accountId: "",
      handle,
      accessToken: password,
      endpoint: serviceUrl,
    });
    return {
      credentials: {
        accessToken: password,
        externalId: session.did,
        endpoint: serviceUrl,
      },
      profile,
    };
  },
};
