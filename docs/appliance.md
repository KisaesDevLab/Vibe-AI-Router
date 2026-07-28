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

## Installing via the Vibe Appliance (recommended)

The appliance ships this router as a first-class app. Files live in the **Vibe-Appliance**
repo, not here:

| File | Purpose |
| --- | --- |
| `console/manifests/vibe-ai-router.json` | app definition — images, ports, env, seed, first-login |
| `apps/vibe-ai-router.yml` | compose overlay (one service, shared Postgres, no host publish) |
| `env-templates/per-app/vibe-ai-router.env.tmpl` | rendered to `/opt/vibe/env/vibe-ai-router.env` |
| `docker-compose.yml` → `emergency-proxy` | publishes `:5193` |

Enable it from the appliance admin console (Apps panel) or `vibe enable vibe-ai-router`. On
enable the appliance: creates `vibe_ai_router_db` + role, generates and **preserves**
`MASTER_KEY` / `SESSION_SECRET` / `ROUTER_ADMIN_PASSWORD`, renders the env file, starts the
container (migrations run at boot), waits for `/healthz`, then runs the seed command —
`node dist/src/ops/bootstrap-firm.js` — which creates the firm, the admin login, registers the
appliance's local model server, populates the catalog from the vendored feed, and applies the
local-first policy pack.

**Two containers, one image.** `ROUTER_ROLE` splits the surfaces so the console can have TLS
without republishing the gateway alongside it:

| Container | Role | Port | Exposure |
| --- | --- | --- | --- |
| `vibe-ai-router` | `gateway` | 8220 | `vibe_net` **only** — no Caddy vhost, no tunnel ingress, no host publish |
| `vibe-ai-router-console` | `console` | 8222 | Caddy vhost (HTTPS) + emergency `:5193` |

The gateway runs migrations at boot; the console sets `SKIP_MIGRATIONS=1` and waits on the
gateway's health check, so two processes never race the same schema. A console container
answers `/v1/*` with a JSON 404 — verified black-box by `scripts/qa-clean-room.ts` whenever
`GATEWAY_URL` differs from `ROUTER_URL`.

**Access.** Console at `https://airouter.<your-domain>`, like any other app. `:5193` remains
the staff fallback — but note that in domain mode session cookies are `Secure`, so signing in
over that plain-HTTP port will not work; it confirms the service is up, and fixing TLS/DNS is
the way back in. Credentials appear in `/opt/vibe/CREDENTIALS.txt` and the first-login card.

**Firewall note.** Docker-published ports bypass UFW's INPUT chain, so `lib/ufw-rules.sh`
also writes a `DOCKER-USER` block into `/etc/ufw/after.rules` that applies the same
RFC1918 + Tailscale policy to the emergency-port range. Without it, `:5171–:5198` are
reachable from the internet on any host with a public IP despite `ufw status` showing them
denied. Confirm with `sudo iptables -L DOCKER-USER -n` after enabling.

**What apps use:** `VIBE_AI_ROUTER_URL=http://vibe-ai-router:8220` on `vibe_net`, with a token
minted per app in the router console (App tokens).

**Classes left unconfigured on a fresh install** are intentional: the pack only assigns models
whose provider kind the firm has actually configured, and only capability-valid ones. A vision
class with no local vision model stays unconfigured and rejects requests (fail closed) until an
admin assigns a model — set `LOCAL_MODEL_VISION=1` if your local server does vision, or add a
provider and pick a model in the Policies page.
