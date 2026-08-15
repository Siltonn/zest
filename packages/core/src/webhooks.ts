import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, schema, sql, type Database } from "@zest/db";
import { domainEventSchema, type DomainEvent } from "./events.ts";

/**
 * Outbound webhooks.
 *
 * A third subscriber to the domain event bus, alongside SSE and the notifier.
 * The producers are untouched — that was the whole point of making the state
 * machine emit events instead of calling the notifier directly, and this is the
 * first time that decision is cashed in.
 *
 * The distinction from the Slack/Discord targets in `notify.ts` is worth
 * keeping straight: those deliver a *notification* — prose aimed at a human who
 * needs to decide something. These deliver an *event* — a machine-readable
 * record aimed at another system. Same transport, different contract, so a
 * schema change to one must not silently reshape the other.
 */

export type WebhookEndpoint = typeof schema.webhookEndpoints.$inferSelect;

/**
 * Derived from the event union rather than written out again, so adding an
 * event type cannot leave the subscribe list quietly missing it.
 */
export const WEBHOOK_EVENT_TYPES = domainEventSchema.options.map(
  (option) => option.shape.type.value,
) as [DomainEvent["type"], ...DomainEvent["type"][]];

/** Deliveries stop after this many consecutive failures. */
export const FAILURE_LIMIT = 15;

export function generateSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/**
 * The signed envelope.
 *
 * Timestamped and versioned because the signature covers both: without the
 * timestamp in the signed payload, anyone who captures one delivery can replay
 * it forever, and receivers have no way to reject stale ones.
 */
export type WebhookDelivery = {
  id: string;
  type: DomainEvent["type"];
  workspaceId: string;
  createdAt: string;
  data: Record<string, unknown>;
};

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Constant-time check, exported so receivers written against this codebase have
 * a correct implementation to copy. The naive `===` leaks the signature one
 * byte at a time to anyone who can measure the response.
 */
export function verifySignature(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
): boolean {
  const expected = signPayload(secret, timestamp, body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Which endpoints want this event.
 *
 * `run.progress` and `sim.event` are excluded unless asked for by name: the
 * simulator alone emits hundreds per fast-forward, and a subscriber that ticked
 * "everything" wants the meaningful events, not a firehose that will get their
 * endpoint rate-limited by their own provider.
 */
const NOISY: ReadonlySet<string> = new Set(["run.progress", "sim.event", "metric.updated"]);

export function endpointsFor(
  endpoints: WebhookEndpoint[],
  event: DomainEvent,
): WebhookEndpoint[] {
  return endpoints.filter((endpoint) => {
    if (endpoint.isActive !== "true") return false;
    if (endpoint.eventTypes.length > 0) return endpoint.eventTypes.includes(event.type);
    return !NOISY.has(event.type);
  });
}

export async function listEndpoints(
  db: Database,
  workspaceId: string,
): Promise<WebhookEndpoint[]> {
  return db
    .select()
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.workspaceId, workspaceId));
}

export async function createEndpoint(
  db: Database,
  input: { workspaceId: string; url: string; eventTypes?: string[]; description?: string },
): Promise<WebhookEndpoint> {
  const [row] = await db
    .insert(schema.webhookEndpoints)
    .values({
      workspaceId: input.workspaceId,
      url: input.url,
      secret: generateSecret(),
      eventTypes: input.eventTypes ?? [],
      description: input.description ?? null,
    })
    .returning();
  return row!;
}

export async function deleteEndpoint(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(schema.webhookEndpoints)
    .where(
      and(
        eq(schema.webhookEndpoints.id, id),
        eq(schema.webhookEndpoints.workspaceId, workspaceId),
      ),
    )
    .returning({ id: schema.webhookEndpoints.id });
  return rows.length > 0;
}

/**
 * One delivery attempt.
 *
 * Returns rather than throws on an HTTP error so the caller can record the
 * status and decide about retrying; throws only when the request could not be
 * made at all. A receiver being down is an expected condition, not a bug.
 */
export async function deliver(
  endpoint: WebhookEndpoint,
  delivery: WebhookDelivery,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const body = JSON.stringify(delivery);
  const timestamp = Math.floor(Date.now() / 1000);

  try {
    const response = await fetchImpl(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Zest-Webhook/1",
        "X-Zest-Event": delivery.type,
        "X-Zest-Delivery": delivery.id,
        "X-Zest-Timestamp": String(timestamp),
        "X-Zest-Signature": `v1=${signPayload(endpoint.secret, timestamp, body)}`,
      },
      body,
      // A receiver that hangs must not hold a worker slot open indefinitely.
      signal: AbortSignal.timeout(10_000),
    });

    return response.ok
      ? { ok: true, status: response.status }
      : {
          ok: false,
          status: response.status,
          error: (await response.text().catch(() => "")).slice(0, 300),
        };
  } catch (error) {
    return { ok: false, status: 0, error: (error as Error).message };
  }
}

/**
 * Record the outcome, and retire an endpoint that has stopped answering.
 *
 * Without the cap, a workspace whose receiver was decommissioned generates a
 * failing job for every event forever. Disabling is reversible from the
 * settings page and leaves the reason visible, which beats silently dropping
 * deliveries or retrying into a void.
 */
export async function recordOutcome(
  db: Database,
  endpointId: string,
  outcome: { ok: boolean; status: number; error?: string },
): Promise<void> {
  if (outcome.ok) {
    await db
      .update(schema.webhookEndpoints)
      .set({
        lastStatus: outcome.status,
        lastError: null,
        lastDeliveredAt: new Date(),
        consecutiveFailures: 0,
      })
      .where(eq(schema.webhookEndpoints.id, endpointId));
    return;
  }

  const [row] = await db
    .update(schema.webhookEndpoints)
    .set({
      lastStatus: outcome.status,
      lastError: outcome.error ?? null,
      consecutiveFailures: sql`${schema.webhookEndpoints.consecutiveFailures} + 1`,
    })
    .where(eq(schema.webhookEndpoints.id, endpointId))
    .returning();

  if (row && row.consecutiveFailures >= FAILURE_LIMIT) {
    await db
      .update(schema.webhookEndpoints)
      .set({
        isActive: "false",
        lastError: `Disabled after ${row.consecutiveFailures} consecutive failures. Last error: ${row.lastError ?? "unknown"}`,
      })
      .where(eq(schema.webhookEndpoints.id, endpointId));
  }
}
