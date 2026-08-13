# Zest skills

Skills that let a coding agent — Claude Code, Cursor, or anything that reads the
[Agent Skills](https://code.claude.com/docs/en/skills) format — operate a running Zest
instance from the terminal.

## Which entry point should I use?

Zest exposes the same domain services three ways, and they suit different clients:

| | Best for | How it connects |
|---|---|---|
| **MCP** (`/mcp`) | Claude Desktop, and anything that speaks MCP natively | Remote HTTP, API key in a header. Ships prompts and resources, so the client offers ready-made actions. |
| **Skills** (this directory) | Claude Code, Cursor — agents already living in a terminal | Plain markdown instructions over the REST API, using tools the agent already has. Nothing to install and no protocol to implement. |
| **REST** (`/api/v1`) | Your own scripts and integrations | API key in a header. The other two are built on it. |

If your client speaks MCP, prefer MCP — it is typed, discoverable, and the tool
descriptions guide the model. Use a skill when the agent already has a shell and you want
it to work without adding a server.

## Installing

Copy the skill into wherever your agent reads skills from:

```bash
cp -r skills/zest-social ~/.claude/skills/
```

Then set the two variables it needs:

```bash
export ZEST_URL=http://localhost:4000
export ZEST_API_KEY=zest_…          # Settings → API keys in the web UI
```

Ask your agent something like *"what's waiting in my Zest queue?"* — the skill's
description is what makes it trigger, so you should not have to name it.

## What is here

- **`zest-social/`** — reviewing the approval queue, drafting posts in a specific
  account's voice, answering audience comments, checking performance, running plans, and
  granting autonomy.

The skill is deliberately opinionated about the things the product is opinionated about:
it reads the voice card before drafting, prefers sending a post back over rejecting it,
and does not approve anything the user did not ask it to approve.
