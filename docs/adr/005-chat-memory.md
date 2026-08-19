# ADR 005 — Chat memory: three layers with a hard boundary

**Status:** Accepted · **Date:** 2026-08-19

## Context

The assistant is the one agent with conversation memory, and until now that memory was
only `lastMessages: 12` — the last dozen messages of the current thread. Everything else
was forgotten: a preference stated on Monday had to be restated on Friday, and a decision
made three weeks ago in another thread was unreachable even though it sat in storage.

Meanwhile the product already has a memory system it is proud of: brand memory — the
brief, strategy, learnings and per-account playbooks — versioned markdown, edited through
proposals, approved in the inbox, visible on the Memory page. Any chat-memory design has
to answer one question first: **what may the chat remember on its own, given that brand
knowledge deliberately cannot change without review?**

## Decision

Three layers, each with a distinct owner, lifecycle and visibility:

| Layer | Holds | Written by | Governance |
| --- | --- | --- | --- |
| Brand memory (existing) | Who the brand is, voice, strategy, learnings | Proposals via `update_memory` | Approval-gated, versioned, on the Memory page |
| Working memory (new) | How the operator works: preferences, standing instructions, current focus, open loops | The agent, mid-turn, silently | Readable and wipeable in the chat panel ("assistant notes") |
| Semantic recall (new) | Nothing of its own — retrieval over past conversation turns | Embeddings written as turns persist | On only when the environment supports it |

The boundary is stated in the assistant's instructions, not just in this document: brand
facts never go in the notepad; they go through `update_memory` so they are reviewed. The
notepad holds what a good account manager keeps in their head about a client — which is
exactly the material an approval flow would make insufferable to maintain.

### Working memory

Mastra working memory, template mode, `scope: 'resource'` where the resource is the
workspace. Cross-thread by construction: taught once, known everywhere. Operators sharing
a workspace share its notes, exactly as they share its brand memory.

A product built on "nothing happens behind your back" does not get an invisible memory,
so the notes are surfaced read-only in the chat panel with a single destructive action —
wipe. Editing is deliberately not offered: the notepad is the agent's record of what it
was told; correcting it happens by telling it, in chat.

### Semantic recall

Vector search over all of the workspace's threads (`scope: 'resource'`, topK 4, with
surrounding turns so a match arrives as a moment, not a fragment), stored via pgvector in
the same `mastra` schema as the messages — `DROP SCHEMA mastra CASCADE` still resets
conversations and their embeddings together.

Recall has two hard prerequisites the code cannot wish away: an embedding provider and
the pgvector extension. The chain mirrors the chat-model chain minus Anthropic (which has
no embeddings API): OpenRouter first (`qwen/qwen3-embedding-4b` — its catalogue refuses
`openai/*` embedding models), then OpenAI (`text-embedding-3-small`), overridable with
`ZEST_EMBEDDING_MODEL`. Both defaults are asked for 1024 dimensions: pgvector will not
index past 2000, and a shared dimension keeps the legs interchangeable on disk.

### Boot-time probes, not runtime surprises

`enableAssistantRecall` runs once per process and proves three things before wiring
anything: an embedder resolves, `CREATE EXTENSION vector` succeeds, and one real
embedding call returns an indexable vector. That last probe is not paranoia — OpenRouter
happily serves a chat key and still refuses embedding calls for some models, and a key
that exists is not a key that works. Any failure leaves chat exactly as it was (recall
off), logs one honest line, and reports through `/me` capabilities so the settings page
can say *why*.

Mastra validates `semanticRecall` in the Memory constructor — naming it without a vector
store throws on import. The agent is a module-level singleton built before any runtime
knows its database, so the memory is handed to the agent as a **resolver**: a base shape
(working memory, history, titles) exists from import, and the recall-enabled shape
replaces it when the probes pass. Resolution happens per turn, which is what lets a
boot-time upgrade reach an agent constructed at import time.

## Considered and deferred: Observational Memory

Mastra also ships Observational Memory — an Observer agent distills conversations into
observations in the background, and a Reflector compresses those when they grow too
large. It solves context management for very long conversations, and it was considered.

Deferred, on four grounds:

- **It would not fire.** The Observer triggers on 30k tokens of unobserved messages per
  thread by default. Zest's chat is short operational sessions — ask, direct, review —
  that rarely approach that. The machinery would idle while still being machinery.
- **The notepad would get slower.** OM can own working memory (`manageWorkingMemory`),
  but extraction happens when observation triggers. Today "remember this" lands in the
  notes within the same turn; under OM a short thread's preference might wait
  indefinitely. For a surface whose point is teaching the agent how you work, that is a
  real regression.
- **Opacity.** Observations and reflections are background-generated intermediate state —
  hard to surface as honestly as one templated document with a wipe button. The product's
  bar is "nothing happens behind your back".
- **Cost and maturity.** Two more standing model consumers, tuned visibly for Gemini
  (default model `google/gemini-2.5-flash`, Google-specific provider defaults), plus a
  cluster of experimental options — in a version where we already found one typed-but-
  unread setting (`indexConfig`).

Revisit when chat grows long-horizon agentic sessions (threads routinely past ~50k
tokens) or a workspace-level narrative memory is wanted: OM with `scope: 'resource'` and
retrieval mode would layer on top of, not replace, the three layers here. `buildMemory`
in `packages/agent/src/agents/assistant/memory.ts` is the single place to add it.

## Consequences

- The stock `postgres:17-alpine` image became `pgvector/pgvector:pg17` in compose — same
  data directory layout, existing volumes carry over. On a database without the
  extension the server still boots; recall is off and says so.
- Existing messages have no embeddings; recall warms up as new turns are written. No
  backfill — the history's value decays fast enough that paying an embedding pass for it
  is not worth the moving part.
- If the embedder fails mid-flight (provider outage), the turn fails visibly and is
  recorded on its run, like any other model failure. No silent degradation path exists at
  runtime by design — degradation is a boot-time decision with a boot-time log line.
- The pipeline roles stay memoryless. Nothing here changes what the strategist or
  copywriter see; brand memory remains their only context, assembled per run.
