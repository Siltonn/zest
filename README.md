# Zest

**An open-source AI social media operations agent.** It researches, drafts, schedules,
publishes, replies, and learns — you approve until you trust it.

![The Zest dashboard: thirteen agent proposals waiting for review, reach and engagement
for the last thirty days, and two connected accounts each with its own
voice](docs/assets/dashboard.png)

Zest ships with **Pomelo**, a simulated social network that lives inside the repo, so the
entire loop runs with **zero API keys**: the agent plans a week of content, you approve it
from an inbox, posts publish on schedule, a simulated audience reacts on a believable
engagement curve, and the agent reads the results and adjusts. No platform application
review, no per-post API billing, no waiting.

> **Status: feature-complete and verified end to end.** A post scheduled through the UI
> publishes to Pomelo over HTTP, a simulated day produces believable engagement, and that
> engagement flows back into analytics and the reply queue.

## Why not just another scheduler

Existing open-source tools are schedulers that added an AI assistant. Zest is built the
other way around — as an operations agent with a supervision UI:

- **Graduated autonomy.** Every mutating tool passes through an autonomy guard. With no
  rule granted it *proposes* (writes a pending row, notifies you); with an `auto` rule it
  *acts*. Same tool, same prompt — only the trust level changes, and every path is audited.
- **Approval is domain data, not a framework pause.** Proposals are ordinary rows, so they
  can be listed, filtered, bulk-approved, expired, deep-linked from Slack, and approved
  over MCP — none of which works if the pending state is buried in a workflow checkpoint.
- **A content wind tunnel.** Because Pomelo's audience is real software, you can A/B a post
  against simulated readers *before* it goes to a live platform — and send the winner
  straight to the approval inbox with its score as the reason.
- **Full provenance.** Each state transition records who caused it — human, agent, system,
  MCP client, or API key — and links to the agent run transcript that produced it.
- **Runs offline, end to end.** `docker compose up` is the whole demo.

## Quick start

```bash
git clone https://github.com/<you>/zest.git && cd zest
cp .env.example .env      # fill in nothing to start — defaults work
docker compose up
```

Then open <http://localhost:3000>.

Without an LLM key the full platform loop still works — compose, schedule, publish,
simulated engagement, analytics, and answering comments by hand. Add one key to `.env` to
switch on planning, drafting, reply triage and analysis:

```bash
OPENROUTER_API_KEY=sk-or-v1-…    # one key, every model, and a spend cap
# or ANTHROPIC_API_KEY / OPENAI_API_KEY — whichever is present wins, in that order
```

OpenRouter is the quickest way to try it, and `ZEST_MODEL` picks the model
(`anthropic/claude-sonnet-5`, `openai/gpt-4o`, anything it routes). The two built-in
defaults are mapped to their OpenRouter slugs automatically, so you only need to set it to
choose something else. Settings shows which provider is actually answering.

### Your first ten minutes

The dashboard walks you through this and ticks each step off as it is actually done,
so there is nothing to memorise:

1. **Connect an account.** Pomelo is built in and needs no credentials — it is a
   working social network with a simulated audience, so the whole loop runs offline.
   Connecting writes a starter voice card for the account.
2. **Say who the brand is.** One page in `/memory`: what you build, who it is for,
   what you never say. Every run reads this first.
3. **Give each account a voice.** Edit the starter card. A founder account and a
   company account should not sound alike, and the agent will not invent the
   difference for you.
4. **Set up a plan and run it.** A plan carries its own cadence and names the accounts it
   writes for — an always-on programme and a launch week spanning both accounts are the
   same mechanism. Research happens once, a strategist plans each programme into concrete
   items, and a writer takes one account at a time so the voices stay apart. Nothing
   publishes — proposals land in `/inbox`.
5. **Approve, edit, or send one back** with a note — the copywriter revises against the
   note and the result comes back for review, so review is a conversation rather than a
   veto. Approving schedules it. Reviews happen at two altitudes: the planned week
   arrives as one card you can prune before anything is written, and the finished drafts
   arrive individually.
6. **Fast-forward a day.** Scheduled posts publish, the simulated audience reacts, and
   their comments come back for triage.

From there it runs on its own: each plan on its own cadence, engagement polling
every five minutes, a nightly analysis that proposes what it learned, and a weekly
report on Monday morning. Everything it wants to change about itself — a strategy
rewrite, a request to stop asking permission — arrives in the same inbox as the posts.

### Local development

```bash
pnpm install
docker compose up -d postgres redis mailpit
pnpm db:migrate
pnpm dev
```

## Architecture

```
apps/web      Next.js 16 — frontend + BFF only. No system API, no DB access.
apps/server   NestJS 11 — one codebase, role chosen by MODE:
                api    → /api/v1 REST, /mcp, /events (SSE), /pomelo, Bull Board, auth
                worker → BullMQ processors, repeatable jobs
                all    → both in one process (default; fine for self-hosting)
packages/
  core        Domain services: state machine, approvals, autonomy guard, notifications
  agent       Agent roles, workflows and tools
  connectors  Platform plugin interface + Pomelo / Bluesky / Mastodon
  simulator   Pomelo engine: personas, engagement curves, trends, sim clock
  db          Drizzle schema, migrations, seed
  shared      Zod schemas, token encryption, timezone helpers
  mcp         MCP server over the same core services
```

Business logic lives in `packages/`. The apps are runtimes, not layers of their own: a REST
controller, an MCP tool, and a queue processor all call the same service functions.

**Async work never runs in a request.** The API enqueues a job and returns immediately; the
worker executes it, writes to Postgres, and publishes a domain event to Redis; the API's SSE
endpoint relays it to the browser. Every job is visible in Bull Board.

**Scheduled publishing cannot double-post.** The sweep enqueues one job per due post keyed
by post id, and the handler claims the row with a conditional
`UPDATE … WHERE status = 'scheduled'` before it talks to any platform. The claim is in the
database, not the queue — losing Redis costs you a retry, never a duplicate post.

## Stack

TypeScript · Next.js 16 + HeroUI · NestJS 11 · Postgres + Drizzle · Redis + BullMQ ·
Better Auth · Mastra (on Vercel AI SDK, so any provider works) · MCP

Design decisions and the arguments behind them are recorded in [`docs/adr/`](docs/adr/):

- [001 — Agent framework](docs/adr/001-agent-framework.md): why Mastra, and why not LangGraph
- [002 — Publishing exactly once](docs/adr/002-scheduling-correctness.md): the claim that
  makes the scheduler trustworthy, and the two bugs found proving it
- [003 — Graduated autonomy](docs/adr/003-graduated-autonomy.md): why approval is domain
  data rather than a paused agent
- [004 — Plans and fan-out](docs/adr/004-plans-and-fan-out.md): why cadence belongs to a
  plan rather than a workspace or an account, and what one-run-per-voice buys


## Drive it from Claude Desktop

Zest is an agent, and it is also something other agents can drive. The MCP
endpoint is served by the running instance — no separate process, no stdio wrapper:

```json
{
  "mcpServers": {
    "zest": {
      "url": "http://localhost:4000/mcp",
      "headers": { "Authorization": "Bearer zest_…" }
    }
  }
}
```

Create the key under **Settings → API keys** (or use the one `pnpm demo` prints). Once
connected you get:

- **Prompts** — *Review my approval queue*, *How did last week go?*, *Draft a post for
  one account*. Ready-made actions, so the integration is usable without inventing the
  phrasing yourself.
- **Resources** — the brand brief, the current strategy, and every plan with its cadence
  and unwritten items, readable without spending a tool call.
- **Tools** — list, approve, reject, request changes, propose a post, read analytics and
  recent activity. Approving a planned week over MCP releases it to the writers exactly
  as clicking approve in the web UI does.

Everything goes through the same `@zest/core` services as the web UI, so an MCP approval
is indistinguishable from a clicked one — except in the audit log, which records which
client did it.

## Drive it from Claude Code

For agents that already live in a terminal, [`skills/`](skills/) ships an Agent Skill that
operates an instance over the REST API — no server to run and no protocol to implement:

```bash
cp -r skills/zest-social ~/.claude/skills/
export ZEST_URL=http://localhost:4000
export ZEST_API_KEY=zest_…
```

Then ask *"what's waiting in my Zest queue?"*. The skill knows the product's opinions:
it reads an account's voice card before drafting, prefers sending a post back over
rejecting it, and approves nothing you did not ask it to approve.

## Extension points

Every one of these is "add one file", by design:

| To add… | Do this |
|---|---|
| A platform | Implement `Connector` in `packages/connectors`, register it |
| An agent role | Add an agent definition in `packages/agent/src/agents` |
| A notification channel | Implement the provider interface in `packages/core/src/notify` |
| A background task | Define a job in the worker role |
| An event consumer | Subscribe to domain events — the state machine doesn't change |
| A different agent framework | Swap the adapter; tools are framework-neutral zod functions |
| An MCP prompt or resource | Register it in `packages/mcp`; it uses the same core services |

## Roadmap

| | Milestone | Ships |
|---|---|---|
| ✅ | **M0** Skeleton | Monorepo, schema, server roles, queue topology, Docker Compose |
| ✅ | **M1** Pomelo + simulator | The simulated network, personas, engagement curves, fast-forward |
| ✅ | **M2** Platform core | Connectors, state machine, audit, composer, calendar, scheduler, analytics |
| ✅ | **M3** Agent core | Agent runtime, tools, layered memory, planning runs, approval inbox |
| ✅ | **M4** Full loop + HITL | Reply triage, analysis runs, autonomy rules, notifications |
| ✅ | **M5** Reach + polish | Bluesky, Mastodon, REST API, MCP server, tests, docs |
| ✅ | **M6** Engagement automation | Auto-plug, auto-reply, auto-DM — all autonomy-gated |
| ✅ | **M7** Agent team | Research once → strategist per plan → writer per account, team view |
| ✅ | **M8** Content wind tunnel | Pre-publish A/B against the simulated audience, winner promotable |

Also shipped: [outbound webhooks](docs/webhooks.md) (signed, retried, one subscriber
on the same event bus that feeds the live UI), a media library with a real lifecycle,
and a `refreshCredentials` hook on the connector contract for OAuth platforms.

Next: Threads and X connectors, a CLI, an SDK generated from the OpenAPI the
controllers already produce, and draft comments so an agent and a human can discuss
a post before it ships.

## License

MIT
