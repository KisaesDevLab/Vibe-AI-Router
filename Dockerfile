# Multi-stage build. Runtime target is Node 24 (suite standard per 15C review) on alpine.
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ui/package.json ./ui/
COPY packages/sdk/package.json ./packages/sdk/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json drizzle.config.ts ./
COPY src ./src
COPY db ./db
COPY data ./data
COPY ui ./ui
COPY packages ./packages
RUN pnpm build \
 && pnpm --filter @kisaes/vibe-ai-client build \
 && pnpm --filter @vibe-ai-router/ui build \
 && pnpm prune --prod

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8220
# Non-root, read-only-fs friendly: the app writes nothing to disk (logs → stdout, state → pg).
USER node
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# migrate.js resolves migrations relative to itself (dist/db/) — place them there
COPY --from=build --chown=node:node /app/db/migrations ./dist/db/migrations
COPY --from=build --chown=node:node /app/data ./data
COPY --from=build --chown=node:node /app/ui/dist ./ui/dist
COPY --from=build --chown=node:node /app/package.json ./package.json
EXPOSE 8220
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8220/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# migrations run before serve — reversible pairs, safe to re-run (idempotent)
CMD ["sh", "-c", "node dist/db/migrate.js up && node dist/src/server/index.js"]
