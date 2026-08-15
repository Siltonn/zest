FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json ./
# Every workspace package the server depends on, or pnpm resolves a
# `workspace:*` against a directory that is not there.
COPY apps/server/package.json ./apps/server/
COPY packages/agent/package.json ./packages/agent/
COPY packages/connectors/package.json ./packages/connectors/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/shared/package.json ./packages/shared/
COPY packages/simulator/package.json ./packages/simulator/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# Turbo walks the dependency graph, so asking for the server is enough to get
# everything under it, in the right order.
RUN pnpm --filter @zest/server... build

# The prune step severs optional peer dependencies this server does not use —
# better-auth declares `next` optional-peer for its Next.js route handler, and
# pnpm links it because apps/web puts Next in the workspace. That link and its
# native SWC binary were 281 MB of a NestJS image.
#
# Severing is sound only while nothing reaches those entry points, so check the
# built output instead of trusting the comment. If someone wires up
# better-auth/next-js later, this fails here rather than at 3am in production.
RUN if grep -rqE 'better-auth/(next|react)' apps/server/dist packages/*/dist 2>/dev/null; then \
      echo "ERROR: a severed integration is imported — update prune-store.mjs"; exit 1; \
    fi

# `pnpm deploy` collects the server and its workspace packages into one
# self-contained tree. `--legacy` because pnpm 10+ otherwise requires the whole
# workspace to opt into injected dependencies, which changes how everyone's
# local install resolves for the sake of one image.
RUN pnpm deploy --legacy --filter=@zest/server --prod /prod \
 && node apps/server/prune-store.mjs /prod next react react-dom

FROM base AS runtime
ENV NODE_ENV=production
# One tree, already pruned: no dev dependencies, no build toolchain, no source.
COPY --from=build /prod ./
EXPOSE 4000
CMD ["node", "dist/main.js"]
