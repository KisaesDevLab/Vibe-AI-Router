# Runbook — Vibe Tax Research Chat (TRC)

**Identity `vibe-tax-research` · SDK git dep `sdk-v0.2.0` · dual-mode, deliberately partial (Q-070) · shipped MIG-4**

Nine of ten background jobs route; interactive chat and `strategy-watch` stay direct until
the router exposes server-side web_search (R1) and embeddings/rerank (R2). That split is
static and reviewed — do not "complete" it by forcing chat through. Three code fixes are
owed (A3, A4, A9).

## 1. Appliance provisioning

Shared P1–P8. App-specifics:

- **Token (P5):** identity `vibe-tax-research`.
- **Cloud provider (P4):** `taxresearch_memo_draft` is cloud_deidentified — bind it to the
  firm's Anthropic or DO provider; scrubber posture (redact default) applies.
- **Policy rows (P7):**

| Class | Tier | Requires | Bind to |
| --- | --- | --- | --- |
| `taxresearch_memo_draft` | cloud_deidentified (seeded) | — | cloud drafting model + a second-provider fallback |
| `taxresearch_content_meta` | local_only (registered) | — | local chat model (cloud-widen candidate, P8) |
| `taxresearch_authoring` | local_only (registered) | — | local chat model (cloud-widen candidate) |
| `taxresearch_chat` | cloud_allowed (seeded) | tools | leave unbound — intentionally unused pre-R1 |

## 2. App configuration

```
VIBE_AI_MODE=router
VIBE_AI_ROUTER_URL=http://vibe-ai-router:8220
VIBE_AI_TOKEN=<minted vibe-tax-research token>
```

Direct-path env (`ANTHROPIC_API_KEY`, `ANTHROPIC_KILL_SWITCH`) stays — chat and
strategy-watch still use it; the kill switch brakes BOTH paths.

## 3. Code changes owed (`apps/api/src/lib/anthropic/router-mode.ts`)

**A3 — honor `timeoutMs`** (lines 197, 210): router-mode calls pass no `AbortSignal`, so a
hung router request runs forever vs the 10–300s per-job direct-mode limits. Fix:

```ts
const signal = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
// pass { ...options, signal } to client.complete / client.stream
```

**A4 — stop double-counting cache reads** (lines 234-237): the router wire `prompt_tokens`
INCLUDES cached tokens (OpenAI wire semantics), and the SDK passes that through unchanged —
so `usage.promptTokens` from the SDK ALSO includes cached tokens (it is NOT disjoint;
`usage.cachedTokens` is the cached subset already counted inside `promptTokens`). When
synthesizing Anthropic-shaped usage, subtract to get the disjoint parts:
`input_tokens = usage.promptTokens - usage.cachedTokens`,
`cache_read_input_tokens = usage.cachedTokens`. Today `usage_daily` adds `cachedTokens` on
top of the full `promptTokens` and overcounts.

**A9 — retry on retryable errors**: wrap router calls in the same retry helper the direct
path uses, keyed on `VibeAiError.retryable` with `retryAfterSeconds` as the initial delay.

Cosmetic (do with A3): map `policy_blocked` to the friendly 503 branch
(`routes/planning/memo.ts:227`); preserve `content_filter`/`error` finish reasons instead
of collapsing to `end_turn` (router-mode.ts:179-183).

## 4. Verification (universal gate + TRC-specific)

1. Run one background-job batch: content_meta over a published page, an authoring pass, a
   memo draft. Each lands in the router ledger under its class.
2. Post-A4: compare the app's `usage_daily` tokens for a run against the router ledger for
   the same requests — they must reconcile (previously cache reads double-counted).
3. Post-A3: stop the router mid-run → jobs fail within their configured timeout, not hang.
4. Memo drafting with a client-named fixture: audit shows `scrubber_redacted`; the draft
   returns.
5. Chat + strategy-watch continue serving via the DIRECT path; `ANTHROPIC_KILL_SWITCH=1`
   stops both direct AND router-side Anthropic traffic (router-side because the class's
   policy can be disabled, app-side because the flag gates the jobs).
6. R1/R2 tracking: when the router ships server-side web_search + embeddings, revisit
   `taxresearch_chat` — until then it stays direct by design.
