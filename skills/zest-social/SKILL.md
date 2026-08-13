---
name: zest-social
description: Run social media operations through a Zest instance — review the approval queue, draft and propose posts in a specific account's voice, answer audience comments, check how a plan or the week performed, and grant or revoke agent autonomy. Use whenever the user mentions Zest, their approval inbox or queue, a content plan or programme, posting to Pomelo/Bluesky/Mastodon, or asks what is waiting for their review.
---

# Operating Zest

Zest is an AI social media operations agent with a supervision UI. This skill drives a
running instance over its REST API, so you can review and act on work from the terminal
instead of switching to the browser.

The single most important rule: **Zest proposes, the operator decides.** Nothing here
publishes on its own, and you should not approve anything unless the user asked you to.

## Setup

Two environment variables:

```bash
export ZEST_URL=http://localhost:4000        # your instance
export ZEST_API_KEY=zest_…                   # Settings → API keys
```

Every request carries the key:

```bash
curl -s -H "Authorization: Bearer $ZEST_API_KEY" "$ZEST_URL/api/v1/inbox"
```

If a call returns 401 the key is wrong or missing; if it returns 400 with a message about
an LLM provider, the instance has no model configured and the thinking steps are off —
the platform loop (scheduling, publishing, replying by hand) still works.

## The mental model

Read this before acting; it is what makes the API make sense.

- **A plan** is a content programme with its own cadence that names the accounts it
  writes for. An always-on beat and a launch week spanning two accounts are the same
  mechanism. Cadence lives on the plan, never on the workspace.
- **A cycle** runs research once for the workspace, a strategist per plan, and a
  copywriter per account. Voices stay apart because each writer sees one account.
- **Review happens at two altitudes.** A planned week arrives as a list of topics you can
  prune before anything is written; finished drafts arrive individually. Dropping a topic
  is cheap, rewriting a draft is not.
- **Autonomy is graduated.** Every mutating action passes a guard. Without a granted rule
  it proposes; with one it acts. Same code either way.

## Reviewing the queue

```bash
curl -s -H "Authorization: Bearer $ZEST_API_KEY" "$ZEST_URL/api/v1/inbox"
```

Returns items with a `kind` that decides where a decision goes:

| kind | What it is | Decide at |
|---|---|---|
| `post` | A drafted post | `/api/v1/posts/{id}/approve` · `/reject` · `/request-changes` |
| `reply` | A drafted answer to a comment | `/api/v1/replies/{id}/approve` · `/reject` |
| `plan` | A planned week; see `planItems` | `/api/v1/plans/{id}/approve` · `/reject` |
| `memory` | A proposed rewrite of a memory doc; compare `before` to `body` | `/api/v1/changes/{id}/approve` · `/reject` |
| `autonomy_request` | The agent asking to stop asking | `/api/v1/changes/{id}/approve` · `/reject` |

Summarise each item for the user with what approving would actually *do*, then wait.

Approving a post schedules it if it carried a suggested time. Approving a plan releases
it to the copywriters, so drafts come back for a second review. Approving a memory
rewrite replaces the document the next run reads. Approving an autonomy request grants a
standing rule — say so plainly, and mention it is revocable.

Sending a post back is usually better than rejecting it — the copywriter revises
against your note and the result returns for review, so the note is worth writing
properly. (With no model configured the post waits for a human edit instead; the
response tells you which happened.)

```bash
curl -s -X POST -H "Authorization: Bearer $ZEST_API_KEY" -H 'content-type: application/json' \
  -d '{"feedback":"Lead with the failure, not the fix."}' \
  "$ZEST_URL/api/v1/posts/$POST_ID/request-changes"
```

Drop one topic from a planned week without rejecting the rest:

```bash
curl -s -X POST -H "Authorization: Bearer $ZEST_API_KEY" \
  "$ZEST_URL/api/v1/plans/items/$ITEM_ID/skip"
```

## Writing a post

Read the voice first — this is the step that separates a usable draft from a generic one.

```bash
curl -s -H "Authorization: Bearer $ZEST_API_KEY" "$ZEST_URL/api/v1/accounts"
curl -s -H "Authorization: Bearer $ZEST_API_KEY" "$ZEST_URL/api/v1/memory"                       # brand brief, strategy
curl -s -H "Authorization: Bearer $ZEST_API_KEY" "$ZEST_URL/api/v1/memory?accountId=$ACCOUNT_ID" # that account's voice card
```

A founder account and a company account must not sound alike. If both would post the same
sentence, the draft is wrong.

```bash
curl -s -X POST -H "Authorization: Bearer $ZEST_API_KEY" -H 'content-type: application/json' \
  -d '{"accountId":"'"$ACCOUNT_ID"'","text":"…","scheduledAt":"2026-09-01T14:00:00Z"}' \
  "$ZEST_URL/api/v1/posts"
```

Omit `scheduledAt` to leave it unscheduled. Check `/api/v1/platforms` for the character
limit before writing rather than after being rejected.

## Answering the audience

Comments the agent has not triaged:

```bash
curl -s -H "Authorization: Bearer $ZEST_API_KEY" "$ZEST_URL/api/v1/inbound"
```

Answer one directly — this works with no model configured, which matters:

```bash
curl -s -X POST -H "Authorization: Bearer $ZEST_API_KEY" -H 'content-type: application/json' \
  -d '{"text":"It falls back to the local cache, then retries with backoff."}' \
  "$ZEST_URL/api/v1/inbound/$ITEM_ID/reply"
```

Or `/ignore` for bait. Answer questions plainly; do not thank a skeptic for their
"feedback" — read what they actually said.

## Checking performance

```bash
curl -s -H "Authorization: Bearer $ZEST_API_KEY" "$ZEST_URL/api/v1/analytics?days=30"
curl -s -H "Authorization: Bearer $ZEST_API_KEY" "$ZEST_URL/api/v1/plans"
curl -s -H "Authorization: Bearer $ZEST_API_KEY" "$ZEST_URL/api/v1/runs"
```

When the numbers are thin, say so rather than inventing a pattern. Four posts is not a
trend.

## Running work

```bash
curl -s -X POST -H "Authorization: Bearer $ZEST_API_KEY" "$ZEST_URL/api/v1/plans/$PLAN_ID/run"
curl -s -X POST -H "Authorization: Bearer $ZEST_API_KEY" "$ZEST_URL/api/v1/agent/triage"
curl -s -X POST -H "Authorization: Bearer $ZEST_API_KEY" "$ZEST_URL/api/v1/ingest/poll"
```

These return `{queued: true}` immediately and finish in the background — a cycle takes
minutes. Poll `/api/v1/runs` to follow it; do not block waiting.

## Autonomy

```bash
curl -s -H "Authorization: Bearer $ZEST_API_KEY" "$ZEST_URL/api/v1/autonomy"
```

Returns the granted rules and the trust record behind them — how many proposals were
approved with no edits, in a row. Grant only what the user asks for, name the action and
scope back to them, and remember that `write_plan` and `schedule_post` mean different
things: the first skips the topic review, the second skips the draft review.

## What not to do

- Do not approve, reject, publish, or grant autonomy unless the user asked. Reporting what
  is waiting is the default; acting on it is not.
- Do not write to the brand brief or a voice card without being asked. They define who the
  brand is, and the instance keeps them under review for exactly that reason.
- Do not retry a failed publish in a loop. Read the error on the post first — a character
  limit and an expired token need different fixes.
