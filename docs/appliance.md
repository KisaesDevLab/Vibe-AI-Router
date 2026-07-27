# Vibe Appliance integration (13.4/13.5)

Port registry: **8220** (block 8220–8229 reserved: 8221 vite dev, 8228 e2e router, 8229 e2e
mock). Image: `ghcr.io/kisaesdevlab/vibe-ai-router` (release.yml publishes on `v*` tags).

## Compose service (apps/vibe-ai-router.yml in the Vibe-Appliance repo)

```yaml
services:
  vibe-ai-router:
    image: ghcr.io/kisaesdevlab/vibe-ai-router:1.0
    restart: unless-stopped
    read_only: true
    networks: [vibe_net]
    expose: ["8220"]           # NO host publish — internal docker DNS only
    environment:
      DATABASE_URL: postgres://airouter:${AIROUTER_DB_PASSWORD}@postgres:5432/airouter
      REDIS_URL: redis://redis:6379/4          # optional
      MASTER_KEY: ${AIROUTER_MASTER_KEY}       # 32B base64; EXCLUDED from Vault backups
      SESSION_SECRET: ${AIROUTER_SESSION_SECRET}
      SECURE_COOKIES: "true"
      HOST: 0.0.0.0
    logging:
      driver: json-file
      options: { max-size: "20m", max-file: "5" }   # log rotation (13.7)
    healthcheck:
      test: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:8220/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval: 30s
      timeout: 5s
```

Console manifest (`console/manifests/vibe-ai-router.json`):
`"ports": { "server": 8220 }`, `"routing": { "default_upstream": "vibe-ai-router:8220" }` on
subdomain **airouter** (D-004).

## Caddy

```
airouter.{$VIBE_DOMAIN} {
  reverse_proxy vibe-ai-router:8220
}
```

Only the **admin UI** goes through Caddy. App traffic uses `http://vibe-ai-router:8220` on
vibe_net directly. `/metrics` and `/v1/*` must NOT be added to any public vhost.

## App provisioning (12.7)

For each app at enable time: mint a token (Admin UI → App tokens, shown once) and set in the
app's env template:

```
VIBE_AI_ROUTER_URL=http://vibe-ai-router:8220
VIBE_AI_TOKEN=<minted>
```

## Vibe Vault backup set (13.5)

Include: the `airouter` Postgres database (config, catalog, policies, **encrypted** credential
rows, ledger, audit). Exclude: nothing else exists — the container is stateless (read-only fs).
**`MASTER_KEY` is deliberately EXCLUDED** — separate-custody escrow per docs/runbook.md; a
restore without it means re-entering provider keys, never data loss. Add a quarterly
restore-test entry to the Vault checklist: restore DB snapshot → boot router → startup check
passes → admin login works → test prompt on a local class succeeds.

## Prometheus

Scrape `vibe-ai-router:8220/metrics` from the appliance's metrics stack (internal network
only). Key series: `vibe_router_requests_total`, `vibe_router_request_duration_seconds`,
`vibe_router_breaker_state`, `vibe_router_budget_rejections_total`,
`vibe_router_scrubber_blocks_total`, `vibe_router_catalog_sync_age_seconds`.
