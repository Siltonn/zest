FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json ./
# Every workspace package the server depends on, or pnpm resolves a
# `workspace:*` against a directory that is not there. Three of the seven were
# listed, which is why this image could not be built at all.
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
# ...and build them too. Turbo walks the dependency graph, so asking for the
# server is enough to get everything under it in the right order.
RUN pnpm --filter @zest/server... build

FROM base AS runtime
ENV NODE_ENV=production
# pnpm does not hoist everything to the root: each package gets its own
# node_modules of symlinks into the root .pnpm store. Copying only the root one
# produced an image that built cleanly and then died on its first line with
# "Cannot find package 'reflect-metadata'" — a dependency of apps/server, which
# lives in apps/server/node_modules. `packages/` carries its own the same way.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/
WORKDIR /app/apps/server
EXPOSE 4000
CMD ["node", "dist/main.js"]
