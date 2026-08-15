# Outbound webhooks

Zest posts every domain event to endpoints you register, so other systems can
react without polling. Add one under **Settings → Outbound webhooks**, or:

```bash
curl -s -X POST -H "Authorization: Bearer $ZEST_API_KEY" -H 'content-type: application/json' \
  -d '{"url":"https://your-service.example/zest"}' \
  "$ZEST_URL/api/v1/webhooks"
```

The response is the only time the signing secret is returned. Copy it.

## What arrives

`POST` with a JSON body:

```json
{
  "id": "9f2b…",
  "type": "post.status_changed",
  "workspaceId": "…",
  "createdAt": "2026-08-15T02:07:44.612Z",
  "data": { "postId": "…", "from": "publishing", "to": "published", "actorKind": "system" }
}
```

| Header | Meaning |
|---|---|
| `X-Zest-Event` | The event type, so you can route without parsing the body |
| `X-Zest-Delivery` | Unique per attempt — use it to make your handler idempotent |
| `X-Zest-Timestamp` | Unix seconds, and part of what is signed |
| `X-Zest-Signature` | `v1=<hex>` — see below |

## Verifying

The signature is `HMAC-SHA256(secret, "<timestamp>.<raw body>")`. Sign the raw
bytes, not a re-serialized object — key order will differ and the check will
fail for no visible reason.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, req, rawBody) {
  const timestamp = req.headers["x-zest-timestamp"];
  const signature = String(req.headers["x-zest-signature"]).replace(/^v1=/, "");

  // Reject anything older than five minutes: without this, a captured delivery
  // replays forever.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  // Compare in constant time; `===` leaks the signature a byte at a time to
  // anyone who can measure your response.
  return a.length === b.length && timingSafeEqual(a, b);
}
```

## Events

`inbox.new` · `post.status_changed` · `clock.advanced` · `metric.updated` ·
`sim.event` · `run.progress`

The last three are high-frequency — a simulator fast-forward emits hundreds of
`sim.event` alone — so an endpoint with no filter does **not** receive them.
Ask for them by name if you want them:

```bash
-d '{"url":"…","eventTypes":["post.status_changed","sim.event"]}'
```

## Retries and failure

Each endpoint gets its own queued job, so a slow receiver never delays another,
and a retry re-sends only to the endpoint that failed. Five attempts with
exponential backoff from 5s. Anything outside 2xx counts as a failure.

After 15 consecutive failures the endpoint is disabled and the reason is shown
in settings — otherwise a decommissioned receiver would generate a failing job
for every event, forever. Re-enable by deleting it and adding it again.

Return 2xx as soon as you have the payload and do the work afterwards. A
receiver that holds the connection open while it processes is a receiver that
will eventually hit the 10s timeout.

## Testing one

Sends a signed sample immediately, and records the result like a real delivery:

```bash
curl -s -X POST -H "Authorization: Bearer $ZEST_API_KEY" \
  "$ZEST_URL/api/v1/webhooks/$ID/test"
```
