# Zest

**An open-source AI social media operations agent.** It researches, drafts, schedules,
publishes, replies, and learns — you approve until you trust it.

Zest ships with **Pomelo**, a simulated social network that lives inside the repo, so the
entire loop runs with **zero API keys**: the agent plans a week of content, you approve it
from an inbox, posts publish on schedule, a simulated audience reacts on a believable
engagement curve, and the agent reads the results and adjusts. No platform application
review, no per-post API billing, no waiting.

> **Status: M0 (skeleton).** The monorepo, database schema, backend roles and queue
> topology are in place. See [Roadmap](#roadmap) for what lands when.

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
  against simulated readers *before* it goes to a live platform.
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
simulated engagement, analytics. Add `ANTHROPIC_API_KEY` to `.env` to switch on planning,
drafting, reply triage and analysis.

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

Design decisions and the arguments behind them are recorded in [`docs/adr/`](docs/adr/).

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

## Roadmap

| | Milestone | Ships |
|---|---|---|
| ✅ | **M0** Skeleton | Monorepo, schema, server roles, queue topology, Docker Compose |
| | **M1** Pomelo + simulator | The simulated network, personas, engagement curves, fast-forward |
| | **M2** Platform core | Connectors, state machine, audit, composer, calendar, scheduler, analytics |
| | **M3** Agent core | Agent runtime, tools, layered memory, planning runs, approval inbox |
| | **M4** Full loop + HITL | Reply triage, analysis runs, autonomy rules, notifications |
| | **M5** Reach + polish | Bluesky, Mastodon, REST API, MCP server, tests, docs |
| | **M6** Engagement automation | Auto-plug, auto-reply, auto-DM — all autonomy-gated |
| | **M7** Agent team | Researcher → strategist → copywriter pipeline, team view |
| | **M8** Content wind tunnel | Pre-publish A/B against the simulated audience |

## License

MIT
