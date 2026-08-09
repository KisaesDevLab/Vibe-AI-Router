# Runbook — Vibe Calculators

**Identity `vibe-calculators` · SDK git dep `sdk-v0.2.0` · dual-mode · shipped MIG-9**

Cleanest integration in the suite. One code fix owed (A6).

## 1. Appliance provisioning

Shared P1–P8. App-specifics:

- **Token (P5):** identity `vibe-calculators` (exact — `packages/llm/src/router.ts:110`
  registers under it).
- **Policy row (P7):**

| Class | Tier | Requires | Bind to |
| --- | --- | --- | --- |
| `calc_loan_extract` | local_only (registered) | json_schema | local qwen3 (cloud-widen candidate if extraction quality wants a bigger model — P8) |

## 2. App configuration

```
VIBE_AI_MODE=router
VIBE_AI_ROUTER_URL=http://vibe-ai-router:8220
VIBE_AI_TOKEN=<minted vibe-calculators token>
```

Boot validation refuses partial config; the resolver fails rather than silently falling
through to direct mode.

## 3. Code change owed (A6) — use SDK `completeJson`

`packages/llm/src/router.ts:71-72` → `loan-extraction.ts:110` reads `result.content` and
bare-`JSON.parse`s it. Local models sometimes answer a forced-JSON request via a tool call,
or fence the JSON in markdown — both throw an unhandled parse error today. The SDK's
`completeJson` (built in 0.2.0 for exactly this) handles the tool-call answer path and
strips fences:

```ts
const { data } = await client.completeJson<LoanFields>(
  'calc_loan_extract',
  messages,
  { name: 'loan_fields', schema: LOAN_SCHEMA },
);
// keep the existing zod validation of `data` at the call site
```

*Effort S.*

## 4. Verification (universal gate + calculators-specific)

1. Loan-document extraction through the real calculator flow → parsed fields render;
   ledger shows `calc_loan_extract` at cost 0.
2. Post-A6: run against a local model known to fence its JSON (qwen family does under some
   prompts) — extraction must parse, not throw.
3. Fail-closed: disable the policy → the calculator surfaces a clear "AI unavailable"
   error, no silent direct fallback.
