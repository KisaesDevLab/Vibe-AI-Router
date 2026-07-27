# Ops runbook

Vault procedures (Phase 6) + operations (Phase 13). Deployment shape: docs/appliance.md.

## Provider outage triage

1. Admin UI → Dashboard: provider tile shows `down`/breaker `open`; audit log shows
   `provider_error` / `fallback_hop` events.
2. If a fallback chain exists, traffic is already being served — confirm via spend-by-model.
3. `POST /admin-api/providers/:id/test` (or the Test button) for a live check.
4. Breaker recovers automatically (half-open probe every `BREAKER_OPEN_MS`, default 30s).
   No manual reset exists — fix the upstream and the probe re-closes the circuit.
5. Persistent outage: reorder the policy fallback chain (Policies page) so the healthy
   provider is primary; revert later.

## Budget override (mid-month unblock)

Hard-stopped firm: raise or clear the limit in Admin UI → Firm settings → Budgets (audited
`config_change`). Per-task-class budgets live on the policy. There is no "one free request"
override by design — change the limit, don't bypass the engine.

## Catalog sync failure

`catalog_sync_failed` audit event + log line; serving is NEVER blocked by sync failures.
Manual retry: Admin bootstrap `POST /admin/catalog/sync` (X-Admin-Token) or wait for the
nightly cron. `vibe_router_catalog_sync_age_seconds` alerts staleness. Refreshing the vendored
feed itself is a release action (data/VENDOR.md).

## Restore procedure

1. Restore the `airouter` database (Vibe Vault → pg restore).
2. Provide `MASTER_KEY` from separate-custody escrow (NOT in the backup).
3. Start the container — migrations re-run idempotently; the vault startup check verifies
   every credential decrypts and refuses boot otherwise (wrong key ⇒ fails loudly here).
4. Verify: admin login → Dashboard test prompt on a local class → ledger row appears.

## Retention (13.7)

- Logs: stdout → docker json-file rotation (20 MB × 5, compose-level).
- `usage_ledger`: retained indefinitely by default (metadata only). Optional purge:
  `LEDGER_RETENTION_DAYS=N` (daily job).
- `audit_log`: **immutable and never purged** — DB trigger blocks UPDATE/DELETE; it is the
  firm's compliance evidence (Q-050).

## Master key

Generate: `openssl rand -base64 32`. Provide as `MASTER_KEY` env (or a secrets file sourced
into the container env). **The master key is deliberately EXCLUDED from the Vibe Vault backup
set** — store a printed/escrowed copy under separate custody (same posture as Vault's recovery
kit). Losing every copy of the master key = every cloud credential must be re-entered (client
data is unaffected; the ledger/audit are unaffected).

## Master key rotation (6.3)

1. Generate the new key: `openssl rand -base64 32`.
2. Run the rewrap (router can stay up — old key still serves until step 3):
   ```bash
   DATABASE_URL=… \
   OLD_MASTER_KEY=<current> OLD_MASTER_KEY_VERSION=1 \
   NEW_MASTER_KEY=<new>     NEW_MASTER_KEY_VERSION=2 \
   pnpm tsx scripts/rotate-master-key.ts
   ```
3. Update the router env: `MASTER_KEY=<new>`, `MASTER_KEY_VERSION=2`, and during a cautious
   window keep `MASTER_KEY_PREVIOUS=<current>`, `MASTER_KEY_PREVIOUS_VERSION=1`.
4. Restart the router. Boot runs the vault startup check — it fails loudly if any credential
   cannot decrypt (never discovers a bad key mid-request).
5. After confirming clean operation, drop `MASTER_KEY_PREVIOUS*` and re-escrow the new key.

## Credential rotation (per provider key, 6.4)

1. `POST /admin/providers/:id/credentials {apiKey}` — staged (`grace`, no expiry).
2. `POST /admin/providers/:id/test {credentialId}` — live 1-token/models-list check.
3. `POST /admin/credentials/:id/promote` — staged → active; old active → grace with
   `CREDENTIAL_GRACE_HOURS` (default 24 h) expiry.
4. Auto-revoke reaps expired grace credentials hourly; or revoke immediately via
   `POST /admin/credentials/:id/revoke`.

All endpoints are write-only regarding key material: responses and listings carry
id/last4/status/key_version only. There is no read-back path at the HTTP layer.
