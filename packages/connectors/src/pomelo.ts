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
 * Pomelo — the simulated network that ships with Zest.
 *
 * This connector speaks HTTP to the Pomelo API served by our own backend. It
 * would be simpler to reach into the database directly, and that is precisely
 * why we do not: routing the demo through the same fetch/serialize/auth path a
 * real platform takes means the offline loop actually tests the integration
 * code, instead of testing a shortcut.
 */

const meta: ConnectorMeta = {
  id: "pomelo",
  name: "Pomelo",
  icon: "🍊",
  color: "#f0803c",
  charLimit: 420,
  maxImages: 4,
  features: ["replies", "images", "threads", "dm"],
  setupHint: "Built in — connects instantly, no credentials needed.",
};

function apiBase(credentials: AccountCredentials): string {
  return (
    credentials.endpoint ?? process.env.POMELO_API_URL ?? "http://localhost:4000/pomelo"
  );
}

async function pomeloFetch<T>(
  credentials: AccountCredentials,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${apiBase(credentials)}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      // Pomelo issues per-user API keys exactly like a real platform would.
      Authorization: `Bearer ${credentials.accessToken ?? ""}`,
      ...init?.headers,
    },
  });

  if (!res.ok) {
    throw new Error(`Pomelo API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export const pomeloConnector: Connector = {
  meta,

  auth: {
    kind: "api_key",
    fields: [
      {
        name: "handle",
        label: "Handle",
        type: "text",
        placeholder: "acme",
        required: true,
      },
    ],
  },

  validate(content: PostContent) {
    return validateAgainstMeta(meta, content);
  },

  async publish(credentials, content): Promise<PublishResult> {
    const post = await pomeloFetch<{ id: string }>(credentials, "/posts", {
      method: "POST",
      body: JSON.stringify({ text: content.text, media: content.media }),
    });
    return {
      externalId: post.id,
      url: `/pomelo/post/${post.id}`,
    };
  },

  async reply(credentials, inReplyToExternalId, content): Promise<PublishResult> {
    const reply = await pomeloFetch<{ id: string }>(
      credentials,
      `/posts/${inReplyToExternalId}/replies`,
      { method: "POST", body: JSON.stringify({ text: content.text }) },
    );
    return {
      externalId: reply.id,
      url: `/pomelo/post/${inReplyToExternalId}#${reply.id}`,
    };
  },

  async fetchEngagement(credentials, since): Promise<EngagementSnapshot> {
    const data = await pomeloFetch<{
      metrics: {
        metric: EngagementSnapshot["metrics"][number]["metric"];
        value: number;
        externalPostId?: string;
        at: string;
      }[];
      inbound: {
        kind: "reply" | "mention" | "dm";
        externalId: string;
        authorHandle: string;
        authorName?: string;
        authorAvatarUrl?: string;
        text: string;
        inReplyToExternalId?: string;
        receivedAt: string;
      }[];
    }>(credentials, `/engagement?since=${since.toISOString()}`);

    return {
      metrics: data.metrics.map((m) => ({ ...m, at: new Date(m.at) })),
      inbound: data.inbound.map((i) => ({ ...i, receivedAt: new Date(i.receivedAt) })),
    };
  },

  async fetchProfile(credentials): Promise<NormalizedProfile> {
    return pomeloFetch<NormalizedProfile>(credentials, "/me");
  },

  async sendDm(credentials, targetHandle, content): Promise<void> {
    await pomeloFetch(credentials, "/dms", {
      method: "POST",
      body: JSON.stringify({ to: targetHandle, text: content.text }),
    });
  },

  async connectWithFields(fields) {
    // Registering an account on Pomelo needs no operator credentials, which is
    // what makes the zero-key demo possible.
    const base = process.env.POMELO_API_URL ?? "http://localhost:4000/pomelo";
    const res = await fetch(`${base}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: fields.handle, displayName: fields.displayName }),
    });
    if (!res.ok) {
      throw new Error(`Could not create the Pomelo account: ${await res.text()}`);
    }
    const created = (await res.json()) as NormalizedProfile & { apiKey: string };
    return {
      credentials: {
        accessToken: created.apiKey,
        externalId: created.externalId,
        endpoint: base,
      },
      profile: created,
    };
  },
};
