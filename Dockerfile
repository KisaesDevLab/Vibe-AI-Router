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
# Probes $PORT, not a literal — the same image runs as the gateway (8220) and the console
# (8222), and a hard-coded port would mark the console permanently unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8220)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# migrations run before serve — reversible pairs, safe to re-run (idempotent)
# Migrations run before serving (reversible pairs, idempotent). SKIP_MIGRATIONS=1 is for
# additional containers of the same image (e.g. the console role) that share one database —
# only one process should drive the schema, and the others wait on its health check.
CMD ["sh", "-c", "if [ \"$SKIP_MIGRATIONS\" = \"1\" ]; then echo 'skipping migrations (SKIP_MIGRATIONS=1)'; else node dist/db/migrate.js up; fi && node dist/src/server/index.js"]
