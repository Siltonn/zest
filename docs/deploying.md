# Deploying

## Which image

Two, and you do not pull them by hand — `docker compose pull` does:

| Image | What it is |
|---|---|
| `ghcr.io/siltonn/zest-server` | NestJS: REST API, `/mcp`, SSE, Pomelo's API, auth, and the BullMQ workers |
| `ghcr.io/siltonn/zest-web` | Next.js: the UI, and a proxy in front of the server |

They are separate because they are separate runtimes, not because they are
separate deployments. One `docker compose up` starts both.

Worth noting what is *not* split: the server's API and its background workers are
the same image, chosen by `MODE=api|worker|all`. Same code, same DI graph — only
`main.ts` decides whether to mount HTTP routes or queue processors. Split them
when agent runs start competing with request latency; until then `all` is one
container and one thing to think about.

## The topology, which is the part that matters elsewhere

**Only `web` needs to be reachable from a browser.** Next.js proxies everything
the client asks for — `/api/v1`, `/api/auth`, `/events`, `/api/pomelo`, `/media` —
to the server over the internal network. So the server wants an internal address
and no public hostname.

```
browser ──▶ web (public)  ──internal──▶ server ──▶ postgres
                                              └──▶ redis
```

That shape holds on every platform below. If you find yourself giving the server
a public URL, check why: the only thing that used to require it was uploaded
images, and those are proxied now.

## Anywhere with Docker Compose

The documented path. A 2 GB VPS is enough to start.

```bash
git clone https://github.com/Siltonn/zest.git && cd zest
cp .env.example .env
docker compose pull && docker compose up -d
```

Then, before it faces the internet:

- `DEMO_MODE=false`. Compose defaults it to `true`, which signs *every*
  request in as the seeded operator. The startup log says so; the log is not a
  security control.
- Replace `ZEST_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` with random values of
  32 characters or more (`openssl rand -base64 32`). The first encrypts platform
  tokens at rest — leaving it at the shipped default is the same as not
  encrypting them. Change it *before* connecting any account: rotating it later
  makes every stored token undecryptable.
- Change the Postgres password from `zest:zest`.
- Set `BETTER_AUTH_URL` and `WEB_URL` to the real public URL, or sign-in
  redirects and email links point at localhost.
- Drop the `5432` and `6379` port mappings. They are there for local
  development and are a database exposed to the internet in production.
- Put TLS in front of `web` — Caddy or nginx, or your platform's load balancer.

## A container PaaS (Railway, Render, Fly.io, Koyeb)

Two services from the published images, plus managed Postgres and Redis.

**server** — `ghcr.io/siltonn/zest-server:0.1.0`, no public hostname, port 4000

```
MODE=all
DATABASE_URL=<managed postgres>
REDIS_URL=<managed redis>
ZEST_ENCRYPTION_KEY=<32+ random>
BETTER_AUTH_SECRET=<32+ random>
BETTER_AUTH_URL=https://your-app.example
WEB_URL=https://your-app.example
MEDIA_DIR=/data/media          # on a persistent volume
DEMO_MODE=false
```

**web** — `ghcr.io/siltonn/zest-web:0.1.0`, public, port 3000

```
SERVER_URL=http://server:4000   # whatever internal address the platform gives
```

Two things platforms get wrong here:

**Media needs a real disk.** `MEDIA_DIR` is a filesystem path, so a platform with
ephemeral containers loses every uploaded image on each deploy while the
`media_assets` rows survive — a library full of dangling references. Attach a
volume, or accept that uploads do not persist.

**The server is not serverless.** It holds SSE connections open and runs
minutes-long agent jobs on a scheduler. A platform that suspends idle containers
or caps request duration will break both. Pick the always-on tier.

## Kubernetes

Two Deployments, two Services, one Ingress pointing at `web`, a PVC for media,
and a Secret for the keys. Nothing here needs an operator or a Helm chart.

Set `MODE=api` on one Deployment and `MODE=worker` on another once you want them
scaled separately — they are the same image. Both apply migrations at startup and
take a Postgres advisory lock first, so rolling several replicas at once is safe:
one migrates, the rest wait and find nothing to do.

## Not Vercel or Netlify

`web` alone would run there, but the server cannot: BullMQ processors are
long-lived, `/events` is a held-open SSE stream, and an agent run outlasts any
function timeout. Splitting the two across providers also gives up the proxy
that keeps everything same-origin. Put both on a machine that stays up.

## Upgrading

```bash
docker compose pull && docker compose up -d
```

The server migrates its own schema before it serves anything, and refuses to
start if a migration fails rather than running against a schema it does not
match. Data lives in the `postgres-data` and `media` volumes; `docker compose
down -v` is the only command that removes them.

Pin `ZEST_VERSION` for anything you would be annoyed to have change under you —
the default is `latest`, and `latest` moves.
