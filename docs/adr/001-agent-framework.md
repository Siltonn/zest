# ADR 001 — Agent framework: Mastra

**Status:** Accepted · **Date:** 2026-08-12

## Context

Zest needs an agent layer that can run several role-specialised agents (researcher,
strategist, copywriter, community manager, analyst), call tools that mutate real domain
data, stream a chat UI, and stay provider-neutral so self-hosters can point it at
Anthropic, OpenAI, or a local model.

The decision went through three positions before settling, and the reasoning matters more
than the conclusion.

### Position 1 — bare Vercel AI SDK tool loop

Initially proposed on the grounds that persistent state lives in the database, so the agent
runtime only has to run short stateless tool loops.

**Rejected.** Our agent layer is heavier than the assistant-style chat that a bare loop
serves well: multi-role pipelines with checkable intermediate artifacts, nightly analysis
loops, per-step retry. Postiz — the largest project in this space — uses a full agent
framework for a *simpler* agent surface than ours. Choosing less framework than the
incumbent for a more demanding job was the wrong trade.

### Position 2 — LangGraph.js

The obvious counter-proposal, and the most recognised agent framework in the job market.

**Rejected**, on the specific grounds below — not on popularity.

### Position 3 — Mastra (accepted)

## Decision

Use **Mastra** for agent definitions, workflow orchestration and tracing. Mastra is built on
the Vercel AI SDK, so provider neutrality, zod-validated tools and streaming survive the
choice.

## Why not LangGraph

LangGraph's core strength is `StateGraph`: arbitrary cycles, conditional edges, and
checkpoint-per-superstep enabling `interrupt()`, resume, and time travel. That is genuinely
finer-grained orchestration than Mastra offers. It is also capability we would not use — our
pipelines are linear (research → strategise → write), and our runs finish in minutes.

The decisive argument is about **where approval lives**, not about graphs.

LangGraph's `interrupt()` models "the agent is mid-task, needs a human answer, and resumes
that task with the answer". Zest's approval is not that shape:

1. **Nothing resumes.** A planning run proposes five posts and is done. Hours later a human
   approves three, edits one, rejects one — and what follows is deterministic code that
   schedules them. There is no LLM context worth restoring.
2. **Proposals must be first-class domain data.** The inbox lists and filters them, users
   bulk-approve, unapproved items expire and get re-planned, Slack deep-links to them, MCP
   clients approve them, and the audit log references them. All of that requires ordinary
   rows. Holding pending state in a checkpointer means mirroring it into domain tables
   anyway — two sources of truth to keep in sync. That is *more* work, not less.
3. **The hard parts are ours either way.** The publishing state machine, the autonomy guard
   (downgrading a tool from "act" to "propose" based on granted trust), and versioned
   layered memory are product logic. No framework supplies them.

Secondary: LangGraph's centre of gravity is Python. The JS port trails the Python library in
maturity and documentation, and its companion observability story (LangSmith) is a hosted
service, which fits a self-hosted project poorly.

## Why Mastra

- **Its primitives match the design.** A role is an agent; a pipeline is a workflow. The
  code reads like the architecture diagram instead of translating into one.
- **Workflows give us what we would otherwise hand-roll**: typed step chains, per-step
  retry, suspend/resume, and tracing across the whole run.
- **TypeScript-first**, not a port — and it composes cleanly with NestJS DI.
- **Self-host friendly tracing** via OpenTelemetry, no SaaS dependency.
- **Built on the Vercel AI SDK**, so `createTool` (zod schema + handler) matches our
  "tools call core services directly" design exactly, and swapping model providers is config.

## Boundary (holds regardless of framework)

Mastra owns **within a run**: roles, step orchestration, retries, tracing.
The domain database owns **between runs**: post state machine, approvals, versioned memory,
audit trail.

Approval is never expressed as a workflow suspend.

## Consequences

- **Accepted cost:** Mastra has far lower name recognition than LangGraph in job postings.
  Mitigated by this ADR — being able to explain precisely why the `interrupt`/checkpoint
  model does not fit demonstrates more than adopting the popular default would; and Postiz
  provides prior art in exactly this domain.
- **Reversible.** Tools are framework-neutral zod functions calling core services, and roles
  are configuration. Switching frameworks means rewriting the adapter in `packages/agent`,
  not the product.
- Agent runs are recorded in the `agent_runs` table with full transcripts, so run replay in
  the UI does not depend on the framework's tracing backend.

## Addendum — provider selection

Three keys are accepted, checked in order: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`. OpenRouter goes first because it is what someone reaches for to try a
project without opening an account with a model vendor — one key, every model, a spend cap.

It needs no new dependency: OpenRouter is OpenAI-compatible, so `createOpenAI` with a
`baseURL` covers it. Two details are easy to get wrong and both fail confusingly:

- **Use `.chat()`, not the default call.** The AI SDK's OpenAI provider defaults to the
  Responses API, which OpenRouter does not implement. The symptom is a 404 that looks like
  a missing model rather than a wrong endpoint.
- **Model ids are namespaced.** `claude-sonnet-5` does not resolve; `anthropic/claude-sonnet-5`
  does. The two built-in defaults are mapped, and anything already containing a `/` is
  passed through as the operator's choice.

One more thing worth writing down because it wastes an afternoon: OpenRouter answers a
*malformed* key with `Missing Authentication header`, which reads like the header never
arrived. A well-formed but unknown key says `User not found.` If you see the first, check
the key's shape before you go looking for a transport bug.
