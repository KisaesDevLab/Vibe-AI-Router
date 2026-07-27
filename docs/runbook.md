# Ops runbook

Started in Phase 6 (vault procedures); Phase 13 completes it (outage triage, budgets,
sync failures, restore).

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
