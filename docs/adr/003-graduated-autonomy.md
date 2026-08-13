# ADR 003 — Approval is domain data, not a framework pause

**Status:** Accepted · **Date:** 2026-08-13

## Context

Zest's central claim is that an agent can run social accounts if a human stays in the loop
until they choose not to be. That makes the approval mechanism the most load-bearing design
decision in the product — more than the model, the prompts, or the framework.

There are two plausible ways to build it.

**A. Pause the agent.** The agent runs, reaches a point needing human input, and suspends.
LangGraph's `interrupt()` does this: the graph state is checkpointed, and a human response
resumes execution from that point.

**B. Write a row.** The agent's tool writes a proposal to the database and the run ends.
Approval is a later, independent operation on that row.

## Decision

**B.** Proposals are ordinary rows in `posts` and `reply_drafts`, in `pending_approval`.

The autonomy guard sits in front of every mutating tool. With no rule granted the tool
writes a proposal and tells the model "sent for approval"; with an `auto` rule the same tool
performs the action. The tool body and the prompt are identical either way — only the
operator's granted trust differs.

### Three things get approved, so three things need rows

Content is the obvious one, but the agent also proposes changes to *itself*: a rewrite of
the strategy document, or a request to stop asking permission for something. Those started
out as audit-log entries, which was a mistake worth recording — an audit row describes
something that happened, and a proposal is something that has *not* happened yet. It had no
status to claim, so nothing could list it as pending, decide it once, or refuse a second
decision. The tools announced these proposals to the inbox and the inbox had nowhere to put
them; two thirds of the approval story were invisible.

They now live in `change_requests` with a `pending → approved | rejected` status, claimed by
the same conditional `UPDATE` the publishing path uses, for the same reason: approving twice
must not grant the rule twice. Approving one is not bookkeeping — it writes the next version
of the memory document the agent reads, or grants the autonomy rule that changes what every
tool may do afterwards. Because they are ordinary rows, they list, deep-link, and approve
over MCP exactly like a post does.

## Why not pause the agent

1. **Nothing resumes.** A planning run proposes five posts and is finished. Hours later a
   human approves three, edits one, and rejects one. What happens next — scheduling the
   approved ones — is deterministic code. There is no LLM context worth restoring, so a
   suspended graph would resume only to find it had nothing left to do.

2. **The product needs proposals to be queryable.** The inbox lists and filters them. Users
   bulk-approve. A cron expires the stale ones. Slack deep-links to a single item. An MCP
   client approves one from Claude Desktop. The audit log references them by id. Every one
   of those is trivial against a table and awkward against checkpointer-internal state — and
   building them would mean mirroring the pending state into domain tables anyway, leaving
   two sources of truth to keep in sync.

3. **A pause blocks; a row does not.** With suspension, an unreviewed proposal holds a live
   graph thread open indefinitely. With rows, the agent finishes, the worker is free, and
   the proposal waits as data.

## Graduated autonomy

Rules match most-specific-first: an account rule beats a connector rule beats a
workspace-wide rule. So "publish freely on Pomelo, keep asking about Bluesky" is expressible
without a special case.

Conditions narrow further — `sentiment: positive` lets replies go out automatically only to
friendly comments; `maxPerDay` caps volume. When a condition is not met the guard downgrades
to approval **and says why**, which surfaces in the UI rather than looking like a bug.

Two deliberate exceptions never auto-apply, even under a granted rule: the brand brief and
account voice cards. An agent quietly rewriting who the brand is would defeat the purpose of
having a brief.

## Earning it

The system tracks how many proposals were approved with no edits, in a row. Past a threshold
the agent may ask for autonomy, once, with the reason. This inverts the usual arrangement:
rather than a settings toggle nobody revisits, autonomy is a decision made against evidence,
at the moment the evidence exists.

## Consequences

- The guard is one function every mutating tool calls. Forgetting to call it is the failure
  mode to watch; it is why tools are grouped in `tools/write.ts` and reviewed together.
- Swapping agent frameworks does not touch any of this, because none of it lives in the
  framework.
- The same design transfers to any approval-gated agent product — support ticket actions,
  financial operations, content moderation. The pattern is "persistent state in the domain
  database, LLM as stateless reasoning, side effects behind a permission gate".
