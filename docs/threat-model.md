# Threat model — STRIDE-lite (14.1)

Scope: the router container on the appliance's internal docker network, its Postgres database,
the Caddy-published admin UI, and the operator's browser. Assets in priority order:
**(1) client data in prompts, (2) firm provider keys, (3) policy integrity, (4) the audit
trail, (5) cost control.**

## T1 — App-token theft (spoofing)

An attacker with a stolen app token can send prompts and burn budget as that app.

- Tokens are 24-byte random, stored SHA-256-hashed, compared constant-time; plaintext shown
  once at mint.
- Blast radius bounded by policy: sensitivity tiers still apply (a stolen tb token cannot make
  local_only data leave the appliance), budgets hard-stop spend, rate limits bound velocity.
- Revocation is immediate (admin UI); `last_used_at` supports anomaly review; every request is
  ledgered + audited by app.
- Residual: a token holder on vibe_net can read whatever that app's cloud-tier classes allow.
  Mitigation is network-level (vibe_net is not exposed off-host).

## T2 — Credential exfiltration (information disclosure)

The firm's provider keys are the router's crown jewels.

- Envelope encryption (AES-256-GCM, per-credential DEK wrapped by the master key);
  **no plaintext column exists; no read-back endpoint exists** (write-only API).
- Keys decrypt only inside `routeForModel`/`testConnection` and flow directly into adapter
  headers; logger redacts `apiKey`/`authorization` paths; tests grep serialized listings,
  audit rows, and provider.health for leakage.
- Master key lives in env only, excluded from backups (separate custody).
- Residual: an attacker with BOTH a DB dump and the master key recovers keys — that is the
  defined trust boundary; the runbook keeps them apart.

## T3 — SSRF via custom base_url (14.2)

Admins enter provider base URLs; a malicious/duped admin could point a "cloud" provider at
internal services (Postgres, appliance console, cloud metadata endpoints) and use the router
as a request proxy.

**Mitigation (implemented in `src/lib/ssrf.ts`, enforced at provider create/update AND at
request time in routeForModel):**

- `openai_compat`/`anthropic` (cloud kinds): base_url must be `https:` and must NOT resolve to
  loopback, RFC-1918/4193/link-local, or metadata ranges (checked by hostname pattern + DNS
  resolution at config time; re-checked by hostname pattern at request time). Firms who
  genuinely need an internal OpenAI-compatible gateway use kind `local`.
- `local` kind: `http(s)` allowed, but host must be a private/LAN or docker-DNS address —
  pinned to the appliance's own network by definition; a local provider pointing at a public
  host is rejected (that would be a covert cloud route around the sensitivity tiers).
- No redirects are followed by adapters into different origins (fetch default policy; error
  bodies truncated).

## T4 — Admin-API authorization (elevation of privilege)

- Session cookie: HMAC-signed id, httpOnly, SameSite=Strict, Secure behind Caddy; mutations
  additionally require the `x-vibe-admin` header (CSRF double-guard); role must be `admin`.
- scrypt password hashes; constant-time compare; login gives no user/password oracle split.
- Bootstrap admin surface (`/admin/*`) is registered ONLY when ADMIN_BOOTSTRAP_TOKEN is set
  and compares hashed tokens constant-time.
- Residual: no login throttling/lockout — acceptable on a LAN-only vhost, flagged for Phase 15
  (Q-052).

## T5 — Log/audit injection (tampering + repudiation)

- Prompt bodies never reach logs (pino redaction paths from Phase 0.10) or the DB (invariant
  suite scans every table for a marker string).
- Audit detail is zod-validated per event type — free-form strings are length-capped and never
  include message content; provider error bodies are truncated to 500 chars.
- `audit_log` is append-only at the DATABASE level (trigger blocks UPDATE/DELETE) — even a
  compromised app role cannot rewrite history without DDL rights.
- Structured JSON logging (pino) — newline injection cannot forge log records.

## T6 — Denial of service / cost bombing

- Body/message/JSON-depth caps pre-parse; per-token + per-user token buckets; per-provider
  concurrency semaphore with bounded queue; circuit breakers; total + idle timeouts; client
  aborts propagate upstream ≤1s (no orphaned token burn); hard budget stops bound worst-case
  spend.

## Non-goals / accepted

- Multi-tenant isolation beyond the firm boundary (single-firm appliance; schema is
  multi-tenant-ready but unaudited for hostile co-tenancy).
- Malicious models/providers returning poisoned content — the router is transport + policy,
  not an output filter (finish_reason `content_filter` is surfaced to apps).
- Physical/host compromise — the appliance's own threat model (Vault, disk encryption).
