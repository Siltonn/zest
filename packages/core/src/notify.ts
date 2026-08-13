import { createTransport, type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { and, eq, schema, type Database } from "@zest/db";

/**
 * Approval notifications.
 *
 * An agent that proposes work is useless if nobody hears about it, so this is
 * part of the core loop rather than a nicety. Channels are provider
 * implementations behind one interface: adding Postmark or Telegram later is a
 * new file and an env var, not a change here.
 */

export type NotificationPayload = {
  workspaceId: string;
  title: string;
  body: string;
  /** Deep link back into the inbox item that needs a decision. */
  url?: string;
  kind?: "approval" | "published" | "failure" | "report";
};

export interface NotificationProvider {
  readonly id: string;
  send(target: NotificationTarget, payload: NotificationPayload): Promise<void>;
}

export type NotificationTarget = typeof schema.notificationTargets.$inferSelect;

/** Prints to stdout. Default in development so the loop works with no setup. */
export class ConsoleProvider implements NotificationProvider {
  readonly id = "console";
  async send(target: NotificationTarget, payload: NotificationPayload): Promise<void> {
    console.info(
      `[notify:${target.kind}] ${payload.title} — ${payload.body}${payload.url ? ` (${payload.url})` : ""}`,
    );
  }
}

export class ResendProvider implements NotificationProvider {
  readonly id = "resend";
  readonly #apiKey: string;
  readonly #from: string;

  constructor(apiKey: string, from: string) {
    this.#apiKey = apiKey;
    this.#from = from;
  }

  async send(target: NotificationTarget, payload: NotificationPayload): Promise<void> {
    const to = target.config.email;
    if (!to) return;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.#from,
        to,
        subject: payload.title,
        html: renderEmail(payload),
      }),
    });

    if (!res.ok) {
      throw new Error(`Resend rejected the message: ${res.status} ${await res.text()}`);
    }
  }
}

/** Slack and Discord both accept a simple JSON body on an incoming webhook. */
export class WebhookProvider implements NotificationProvider {
  readonly id: "slack" | "discord";

  constructor(id: "slack" | "discord") {
    this.id = id;
  }

  async send(target: NotificationTarget, payload: NotificationPayload): Promise<void> {
    const url = target.config.webhookUrl;
    if (!url) return;

    const text = payload.url
      ? `*${payload.title}*\n${payload.body}\n<${payload.url}|Review it>`
      : `*${payload.title}*\n${payload.body}`;

    const body =
      this.id === "slack"
        ? { text }
        : { content: text.replace(/\*/g, "**").replace(/<(.+)\|(.+)>/, "$2: $1") };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`${this.id} webhook failed: ${res.status}`);
    }
  }
}

function renderEmail(payload: NotificationPayload): string {
  const button = payload.url
    ? `<p style="margin:24px 0"><a href="${payload.url}" style="background:#e8a33d;color:#1a1a1a;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Review in Zest</a></p>`
    : "";
  return `<div style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:520px">
  <h2 style="margin:0 0 8px">${escapeHtml(payload.title)}</h2>
  <p style="white-space:pre-wrap;line-height:1.5">${escapeHtml(payload.body)}</p>
  ${button}
  <p style="color:#888;font-size:12px">Sent by Zest</p>
</div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type NotifierOptions = {
  mailProvider?: NotificationProvider;
  webUrl?: string;
};

export class Notifier {
  readonly #providers: Map<string, NotificationProvider>;
  readonly #options: NotifierOptions;

  constructor(options: NotifierOptions = {}) {
    this.#options = options;
    const mail = options.mailProvider ?? new ConsoleProvider();
    this.#providers = new Map<string, NotificationProvider>([
      ["email", mail],
      ["slack", new WebhookProvider("slack")],
      ["discord", new WebhookProvider("discord")],
    ]);
  }

  /**
   * Fans out to every configured channel. One failing webhook must not stop
   * the others, and must never fail the job that triggered the notification —
   * a post still published even if Slack was down.
   */
  async dispatch(db: Database, payload: NotificationPayload): Promise<void> {
    const targets = await db
      .select()
      .from(schema.notificationTargets)
      .where(eq(schema.notificationTargets.workspaceId, payload.workspaceId));

    const now = new Date();
    const deliveries = targets
      .filter((t) => t.digestMode === "instant")
      .filter((t) => !inQuietHours(t, now))
      .map(async (target) => {
        const provider = this.#providers.get(target.kind);
        if (!provider) return;
        try {
          await provider.send(target, { ...payload, url: this.#absoluteUrl(payload.url) });
        } catch (error) {
          console.warn(
            `[notify] ${target.kind} delivery failed: ${(error as Error).message}`,
          );
        }
      });

    await Promise.all(deliveries);
  }

  /** Targets set to `daily` are collected here for the morning summary. */
  async digestTargets(db: Database, workspaceId: string): Promise<NotificationTarget[]> {
    return db
      .select()
      .from(schema.notificationTargets)
      .where(
        and(
          eq(schema.notificationTargets.workspaceId, workspaceId),
          eq(schema.notificationTargets.digestMode, "daily"),
        ),
      );
  }

  #absoluteUrl(path?: string): string | undefined {
    if (!path) return undefined;
    if (path.startsWith("http")) return path;
    return `${this.#options.webUrl ?? "http://localhost:3000"}${path}`;
  }
}

/** Quiet hours may wrap midnight (22 → 7), so the comparison flips. */
function inQuietHours(target: NotificationTarget, now: Date): boolean {
  const quiet = target.quietHours;
  if (!quiet) return false;
  const hour = now.getUTCHours();
  return quiet.start <= quiet.end
    ? hour >= quiet.start && hour < quiet.end
    : hour >= quiet.start || hour < quiet.end;
}

/**
 * Plain SMTP, for self-hosters who would rather not add a SaaS dependency —
 * and for the demo, where Docker Compose already runs Mailpit on 1025 and the
 * approval mail should actually arrive somewhere you can open.
 */
export class SmtpProvider implements NotificationProvider {
  readonly id = "smtp";
  readonly #from: string;
  readonly #options: SMTPTransport.Options;
  #transport: Transporter | undefined;

  constructor(options: SMTPTransport.Options, from: string) {
    this.#options = options;
    this.#from = from;
  }

  async send(target: NotificationTarget, payload: NotificationPayload): Promise<void> {
    const to = target.config.email;
    if (!to) return;

    // Created lazily and reused: building a transport per message would open a
    // fresh connection for every approval notice.
    this.#transport ??= createTransport(this.#options);

    await this.#transport.sendMail({
      from: this.#from,
      to,
      subject: payload.title,
      html: renderEmail(payload),
      text: `${payload.title}\n\n${payload.body}${payload.url ? `\n\n${payload.url}` : ""}`,
    });
  }
}

export function createMailProvider(
  provider: "resend" | "smtp" | "console",
  config: {
    apiKey?: string;
    from?: string;
    host?: string;
    port?: number;
    user?: string;
    pass?: string;
  },
): NotificationProvider {
  if (provider === "resend" && config.apiKey) {
    return new ResendProvider(config.apiKey, config.from ?? "Zest <zest@resend.dev>");
  }

  if (provider === "smtp" && config.host) {
    return new SmtpProvider(
      {
        host: config.host,
        port: config.port ?? 1025,
        // Mailpit and most local relays speak plaintext; anything on 465 will
        // not, so infer rather than making the operator set a third variable.
        secure: config.port === 465,
        ...(config.user
          ? { auth: { user: config.user, pass: config.pass ?? "" } }
          : {}),
      },
      config.from ?? "Zest <zest@localhost>",
    );
  }

  // Printing beats silently dropping an approval notice.
  return new ConsoleProvider();
}
