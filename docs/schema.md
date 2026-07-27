# Data model

Source of truth: `db/schema.ts` (types) + `db/migrations/0001_data_model` (DDL). This doc is the
navigable summary; regenerate mentally from those two when in doubt — drift is a gap-checklist
failure.

## Invariant

**No table stores prompt or completion bodies.** `usage_ledger` and `audit_log` carry metadata
and `request_hash` (SHA-256 of canonicalized messages) only. `audit_log` is append-only,
enforced by a DB trigger.

## Tables

| Table | Purpose | Notable |
| --- | --- | --- |
| `firms` | tenant root (single-firm appliance, multi-tenant-ready) | `settings` jsonb: scrubber_mode, banned kinds/patterns, global temperature max |
| `users` | admin/partner/staff | `external_ref` reserved for SSO-later |
| `providers` | firm-configured endpoints | soft-delete `deleted_at`; `model_mapping` for Azure deployment names; `health` jsonb |
| `provider_credentials` | envelope-encrypted keys | **no plaintext column exists**; `key_version`, `last4`, rotation via `status`/`grace_until`/`rotated_from` |
| `models` | catalog | `canonical_id` unique; `capabilities` (synced) vs `capability_overrides` (manual, survive re-sync); `status` active/deprecated/sunset |
| `model_pricing` | append-only $/MTok history | `effective_from` enables historical ledger recompute; NULL pricing → `cost_unknown` |
| `task_classes` | the central abstraction | `key` globally unique; `sensitivity` local_only/cloud_deidentified/cloud_allowed; `requires` capability set |
| `policies` | (firm, task class) → routing | `default_model_id`, `allowed_model_ids[]`, `fallback_chain[]`, limits, `monthly_budget_cents`; unique (firm, task class) |
| `role_policies` | role gating per policy | PK (policy, role) |
| `usage_ledger` | exactly one row per request | `request_id` unique = idempotency; `cost_cents` numeric(12,6); `cost_unknown`/`cost_estimated` flags; `engagement_ref`/`client_ref` for T&B feed |
| `audit_log` | every pipeline decision | `event` is text + app-side zod registry (Q-005); append-only trigger |
| `budgets_state` | denormalized budget fast path | unique (scope, scope_ref, period yyyymm) |
| `app_tokens` | how Vibe apps authenticate | SHA-256 `token_hash` unique; `scopes[]`; `revoked_at` |

## Indexes

`usage_ledger`: (firm_id, ts), (task_class_id, ts), (client_ref, ts). `audit_log`: (firm_id, ts),
(event, ts). `model_pricing`: (model_id, effective_from). `budgets_state`: unique triple.

## Seed (`pnpm seed`)

Demo firm (`demo-firm`, scrubber block mode), admin `admin@demo.firm`, local Ollama provider
(`http://vibellm:11434/v1`), 5 fixture models with pricing (2 local at $0, Sonnet/Haiku/4o-mini),
3 task classes covering all three sensitivity tiers with capability-valid policies, and app token
`vibe-tb-demo-token` (hash stored, plaintext printed). Idempotent.
