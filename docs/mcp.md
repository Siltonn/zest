# Connecting over MCP

Zest is an agent, and it is also something other agents can drive. The deployed
instance exposes an MCP server at `/mcp` (streamable HTTP): Claude — or any MCP
client — can review the approval queue, propose posts, approve work, and read
analytics, against the same `@zest/core` services the web UI uses. Every
mutation lands in the audit log as an `mcp` actor, carrying either the API key
that made it or the user whose OAuth session authorized it.

## Two ways to authenticate

### OAuth — for Claude's custom connectors (no setup)

Point a custom connector at `https://<your-instance>/mcp`. That is the whole
configuration: the client discovers everything else on its own.

What happens under the hood, all specified by the MCP authorization spec:

1. The first request gets a `401` whose `WWW-Authenticate` header names the
   protected-resource metadata (RFC 9728) at
   `/.well-known/oauth-protected-resource`.
2. That document names the authorization server; its metadata (RFC 8414) lives
   at `/.well-known/oauth-authorization-server`.
3. The client registers itself (RFC 7591 dynamic client registration) and runs
   the authorization-code + PKCE flow.
4. The browser lands on `/authorize` — Zest's login and consent page. Sign in
   if needed, then explicitly approve. Registration is open, so that click is
   the only thing standing between "someone sent me a link" and "an agent acts
   as me": no code is issued without a matching row in `oauth_consents`.
   Approving records the grant, so the *same* client asking again for the same
   scopes goes straight through — a client asking for more does not.
5. The token the client receives acts *as the user who approved it* — full
   power, including approvals, and everything it does is audited as
   `mcp { clientId, userId }`.

Access tokens are JWTs (1 h), signed with the key pair in `jwks` and
audience-bound to `<public-url>/mcp`; `/mcp` verifies the signature against
`/api/auth/jwks` rather than looking the token up. Refresh tokens (7 d) are
rows in `oauth_refresh_tokens`.

**Revoking a connection** therefore means deleting the client's row in
`oauth_consents` and its `oauth_refresh_tokens` — which stops renewal and forces
the next authorization back through the consent screen. The access token the
client already holds keeps working until it expires, at most an hour: nothing
looks it up, so nothing can turn it off early.

### API keys — for headless clients

Mint a key in **Settings → API keys** and send it as `Authorization: Bearer
zest_…` (or `x-api-key`). Claude's connector UI has no header field — this path
is for clients that do:

```bash
claude mcp add --transport http zest https://<your-instance>/mcp \
  --header "Authorization: Bearer zest_..."
```

Keys carry **scopes**, chosen at mint time:

| scope     | grants                                                              |
| --------- | ------------------------------------------------------------------- |
| `read`    | inbox, accounts, analytics, memory, audit — every key has this      |
| `propose` | add work that still gets reviewed: propose posts, trigger planning  |
| `approve` | decide: approve/reject/request changes, schedule, publish-now       |

The MCP tool list itself is scope-shaped — a read-only key never even sees the
`approve` tool. Legacy keys (minted before scopes) keep their old full power.

## What no credential can do

Some decisions must trace to a person, whatever the credential:

- **Granting autonomy.** Approving an `autonomy_request` — "the agent may act
  without review from now on" — is refused for API keys outright, over MCP and
  REST alike. It needs a session or a user-authorized OAuth token. A standing
  machine credential that could widen its own leash would be the exact
  escalation the approval loop exists to prevent. (Revoking autonomy only needs
  `approve` — the kill switch has fewer preconditions than the thing it stops.)
- **Minting credentials and channels.** Creating/deleting API keys, webhook
  endpoints, and notification targets requires a signed-in user.

`DEMO_MODE` never applies to `/mcp`: the demo's sign-everyone-in convenience is
for browsers, and extending it to machine clients would record their actions as
a human — poisoning both the audit trail and the approval-streak stats that
autonomy graduation reads.

## Topology

Only the web container needs to be reachable. Next.js proxies the three things
an MCP client touches — `/mcp`, `/.well-known/*`, `/api/auth/*` — to the
internal server, exactly like the rest of the API. One requirement follows:
the OAuth issuer must be the *public* origin, so `BETTER_AUTH_URL` either stays
unset (it follows `WEB_URL`) or is set to the public URL. An internal address
there breaks connector discovery.

## Transport notes

- Streamable HTTP, stateless: each POST gets a fresh server bound to the
  credential's workspace and scopes. No sessions to leak or lose on restart;
  the trade-off is no server-initiated messages (notifications, elicitation),
  which nothing here needs yet.
- `GET`/`DELETE` return `405` per spec — there is no standalone stream and no
  session to terminate.
- Responses are plain JSON (`enableJsonResponse`), which survives every proxy.

## Tools, prompts, resources

Tools declare spec annotations (`readOnlyHint`, `destructiveHint`,
`openWorldHint`) so clients can calibrate their own confirmation UX — `approve`
is flagged destructive and open-world because an approved post with a slot
publishes to an external network.

Prompts (`review_queue`, `week_in_review`, `draft_for_account`) and resources
(brand brief, strategy, plans) follow the same scope gating as the tools they
rely on.

One deliberate asymmetry: `propose_post` **always** files into the approval
inbox, even where an autonomy rule lets Zest's own agent auto-publish. Autonomy
is trust the operator granted to *this workspace's agent*; an external MCP
client is not that agent.
