# ADR 004 — Cadence belongs to a plan, not to the workspace or the account

## Context

Planning cadence lived on the workspace: one cron, one setting, every account moving at
the same speed. That is wrong for the case the product is built around — a founder
account riffing daily beside a brand account posting twice a week.

The obvious fix is to move the cadence onto the account. Following that through exposes
the deeper problem, though: "plan" meant three different things in the codebase — the
cron, the run that fired, and the strategist's weekly content plan. The third one was the
valuable one, and it was the one that did not exist. It was a string interpolated into
the copywriter's prompt and then dropped into a transcript blob. It could not be read,
edited, retried, or traced to the posts it produced.

## Decision

**A plan is a domain object that carries a cadence and targets accounts.**

```
plans          name, objective, schedule, status, startsAt?, endsAt?
plan_accounts  plan × account          — many-to-many
plan_items     plan × account × topic × angle × slot → postId
```

Cadence moves from `workspaces.planningSchedule` (dropped) onto `plans.schedule`.

### Why not per-account cadence

Because a plan already names its accounts, per-account rhythm falls out of it for free:
an account's real cadence is the union of the plans pointing at it. Nesting plans *under*
an account would have bought the same thing and lost the case that matters most — a
launch week spanning both accounts, which is the only reason sharing research between
them makes sense.

## The fan-out

Each layer is scoped to its own natural boundary rather than pushed down uniformly:

| Stage | Scope | Why not narrower |
|---|---|---|
| Researcher | workspace, once per cycle | Trends and performance are shared. Running it per account spends N× the tokens on near-identical output *and* de-coordinates the accounts. |
| Strategist | one run per plan | This is the unit with a cadence and an objective. |
| Copywriter | one run per account per plan | Isolation, below. |

```
researcher (1×) ──briefing──> strategist (per plan) ──plan_items──> copywriter (per account)
```

Each stage is a separate BullMQ job that enqueues the next, rather than three calls
inside one function. A plan whose strategist fails is one retry, not a lost cycle, and
each stage is a separate row in `agent_runs` with its own transcript.

### Context isolation is the point of the third stage

The copywriter used to receive every account in a single context and be asked to switch
voice between items. That is how a founder account starts sounding like a press release.
One run per voice costs more and keeps them apart — and it is the concrete answer to
"what does multi-agent buy you", which is not "the agents talk to each other" but "each
one sees only what it should".

## Consequences

- **Posts can explain themselves.** `plan_items.postId` links a published post back to
  the intention that produced it, and to the run that wrote it.
- **A cheaper review altitude exists, and it runs through the same guard as everything
  else.** `write_plan` is an autonomy action: with no rule granted, a planned week lands
  in the inbox as one card — topics grouped by account, each droppable — and the
  copywriter only runs once it is approved. Grant the rule and the same stage goes
  straight to the writers. Deciding on six topics costs a fraction of reading six
  finished drafts, and dropping one saves the model call that would have written it.
  One card per plan rather than one per topic, or a week of content would bury the posts
  and replies sharing that inbox.
- **An item stops being pending the moment it is written**, so a retried copy stage
  cannot double-post. This is the same conditional-claim instinct as publishing, one
  layer up.
- **Stale timers have to be pruned.** Schedulers are keyed `plan-<planId>`; the boot
  sync removes any key with no live plan behind it. Without that, upgrading from the
  workspace-level cadence leaves a `plan-<workspaceId>` scheduler firing forever
  alongside the new ones, and everyone plans twice a day.
- The strategist's tool filters submitted items to the plan's own accounts, so a
  wandering model cannot create work the fan-out will never pick up.
