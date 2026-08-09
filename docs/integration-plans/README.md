# Per-app integration runbooks — router ≥ 0.0.6

One runbook per Vibe app. Each is a **complete, gap-free implementation process**: appliance
provisioning, app configuration, code changes still owed in the app repo, and a verification
checklist with failure diagnosis. Written 2026-08-08 against router 0.0.6 (Q-071…Q-075
fixes applied) from the Round J cross-repo review.

| Runbook | App | Registration identity | Remaining app-side work |
| --- | --- | --- | --- |
| [trial-balance-app.md](trial-balance-app.md) | Vibe Trial Balance | `vibe-tb` | A7 (headers) |
| [mybooks.md](mybooks.md) | myBooks | `vibe-mybooks` | A2 (errors); optional R4 OCR routing |
| [payroll-time.md](payroll-time.md) | Vibe Payroll-Time | `vibe-payroll-time` | none |
| [tax-research-chat.md](tax-research-chat.md) | Vibe Tax Research Chat | `vibe-tax-research` | A3, A4, A9 |
| [transaction-convertor.md](transaction-convertor.md) | Vibe Transaction Convertor | `vibe-tx-converter` | A5; optional R4 OCR routing |
| [time-billing.md](time-billing.md) | Vibe Time & Billing | `vibe-time-billing` | A1 (cost recovery), A8 |
| [calculators.md](calculators.md) | Vibe Calculators | `vibe-calculators` | A6 |
| [no-ai-apps.md](no-ai-apps.md) | Vibe-1099, Vibe-Connect, rest of suite | — | none (no AI code) |

---

## The shared provisioning sequence (run once per firm, before any app)

Every runbook assumes these appliance-side steps are done. Do them in order; each step's
output is the next step's input.

**P1. Router up and healthy.** Deploy router ≥ 0.0.6; migrations run on boot. Verify:
`curl http://vibe-ai-router:8220/healthz` → `{"status":"ok"}` (0.0.5+ probes Postgres — a
503 `degraded` here means the DB is down, fix that first) and `/version` shows ≥ 0.0.6.

**P2. Local provider (vibellm/Ollama).** Providers → Add provider → "Ollama (local)" →
`http://vibellm:11434/v1`. Click **Test connection** — expect ✓ with a model count and the
capability probe. Pull the models the firm will use (`ollama pull qwen3:14b`, a vision model
if any app needs one) BEFORE binding policies.

**P3. Optional GLM-OCR provider (R4).** If the appliance runs the shared GLM-OCR service:
Providers → Add provider → "GLM-OCR (local)" → `http://vibe-glm-ocr:8090/v1`, no key. Test
connection (✓ = llama-server answered `/models`). Then Catalog → Add custom model:
canonical id `glm/GLM-OCR`, kind `local_ocr`, context 8192 (or per your build), capabilities
**vision = true**, pricing 0. `local_ocr` is LOCAL-tier: usable by `local_only` classes,
scrubber-exempt, LAN-pinned.

**P4. Optional cloud providers.** Anthropic preset (`https://api.anthropic.com`) and/or
DigitalOcean Gradient preset (`https://inference.do-ai.run/v1`) with the firm's own keys.
Test connection must show ✓ (0.0.4+ validates keyless-model-free via `GET /v1/models`).
Catalog sync populates cloud models; DO models come from the curated feed.

**P5. Mint the app token.** Tokens → create with **exactly** the app's registration
identity from the table above. The router 403s registration when the token's app ≠ the
`app:` the code sends — the app then retries forever and every AI feature stays
fail-closed. Copy the plaintext token now; it is shown once.

**P6. Configure + boot the app** (per its runbook): set `VIBE_AI_MODE=router`,
`VIBE_AI_ROUTER_URL=http://vibe-ai-router:8220`, `VIBE_AI_TOKEN=<from P5>`. Boot. The app
registers its task classes; verify in the router log or Policies page (new classes appear,
tier `local_only`).

**P7. Bind policies.** Policies → each of the app's classes → set default model, allowed
set, fallback chain. **A class with no policy row fails closed — this is the #1 missed
step.** Capability gating is enforced at save time: a class requiring vision/tools only
offers capability-valid models; if the list is empty, fix P2/P3 (pull the model, set a
capability override after verifying).

**P8. Tier adjustments (optional, audited).** Policies → open class → tier selector.
Conservative-default `local_only` classes may be widened to `cloud_deidentified` /
`cloud_allowed` to route to Anthropic/DO models; the scrubber still runs on every
cloud-bound request. Compliance-pinned classes (payroll, statements, W-9s — see
SENSITIVITY-REVIEW.md) should be widened only as a deliberate compliance decision.

---

## Universal verification gate (every app, after its runbook)

1. **Registration**: app boot log shows `task classes registered`; no 401/403 loop.
2. **Live request per class** through the app's real feature (not curl).
3. **Ledger**: Dashboard → usage shows the request with correct task class, app, model
   served, non-null cost columns (`cost_unknown=false` for priced models).
4. **Fallback** (where a chain exists): stop the primary provider, repeat the request,
   confirm the hop in the audit log (`fallback_hop`) — and for a local-primary +
   cloud-fallback chain, confirm `scrubber_redacted` fired (Q-072).
5. **Streaming** (apps that stream): first token arrives, `[DONE]` terminates, usage lands
   in the ledger.
6. **Fail-closed**: temporarily disable the class's policy → app receives `policy_blocked`
   and surfaces a sane error (never a silent fallback to direct mode).
7. **Direct-mode SDKs**: provider SDK deps deleted from the app, or provably dormant in
   router mode.

## Connection troubleshooting (symptom → cause → fix)

| Symptom | Cause | Fix |
| --- | --- | --- |
| App boot: refuses to start naming `VIBE_AI_*` | Partial env (by design) | Set all three vars (P6) |
| `auth_error` (401) on every call | Wrong/revoked token | Re-mint (P5); check Tokens page `lastUsedAt` |
| Registration 403 `token is for app X, not Y` | Token identity ≠ code identity | Re-mint token with the exact identity from the table |
| `policy_blocked: unknown task class` | Registration never succeeded | Fix the 403/boot order; check router logs |
| `policy_blocked: no enabled policy` | P7 skipped for that class | Bind the policy |
| `capability_missing` | Model lacks tools/json_schema/vision | Pick a capable model; verify Ollama probe; capability override if the probe under-reports |
| `provider_unavailable: no X provider configured` | Class's model kind has no provider row | Add the provider (P2–P4) |
| `base_url rejected` when saving a provider | SSRF gate: cloud kinds must be public https; local kinds must be LAN/docker | Use the right kind for where the endpoint lives |
| Test connection ✗ `invalid_request` on Anthropic | Router < 0.0.4 | Upgrade — 0.0.4 fixed the empty-model test |
| Multi-page extraction dies with `length` | Router < 0.0.5 clamped `txconv_statement_parse` to 4096 | Upgrade to ≥ 0.0.5 (32k floor) |
| `/healthz` ok but every request 500s | Router < 0.0.5 healthz lied | Upgrade — 0.0.5 probes the DB |
| Requests hang with no timeout (TRC) | App drops `timeoutMs` in router mode | Apply A3 in the TRC runbook |
| Cost shows $0 in Time-Billing admin | A1 not built | Time-Billing runbook step 4 |
