# Runbook — Vibe Payroll-Time

**Identity `vibe-payroll-time` · vendored SDK 0.2.0 · dual-mode · shipped MIG-7**

No app code changes owed — the wire contract verified clean. Everything here is
provisioning; the two historical traps (identity mismatch, tool capability) are called out.

## 1. Appliance provisioning

Shared P1–P8. App-specifics:

- **Token (P5): identity `vibe-payroll-time` — the exact string.** Router ≥ 0.0.5 renamed
  the pack entry to match; older docs said `vibe-payroll`, and a token minted under that
  name makes registration 403 forever (the app retries every ≤60s and all AI features stay
  fail-closed with nothing louder than a log line).
- **Local model MUST have tool calling** for `payroll_nl_correction`. Verify via the
  provider Test connection (Ollama capability probe shows `tools: true`) or set a
  capability override after manually verifying the model handles tool calls.
- **Policy rows (P7):**

| Class | Tier | Requires | Bind to |
| --- | --- | --- | --- |
| `payroll_nl_correction` | local_only (registered) | **tools** | local tool-calling model (qwen3 works) |
| `payroll_support_chat` | local_only (registered) | — | local chat model |

`payroll_anomaly_review` (pack) is unused by the app — ignore or retire; it needs no policy.

**Do not widen these classes** (P8): SSNs + wages are the definition of local-only data
(MIG-7). The tier control will let you; compliance says don't.

## 2. App configuration

```
VIBE_AI_MODE=router
VIBE_AI_ROUTER_URL=http://vibe-ai-router:8220
VIBE_AI_TOKEN=<minted vibe-payroll-time token>
```

Config validation: `backend/src/config/env.ts:239-273` refuses to boot on partial config.
Registration: `backend/src/services/ai/router-mode.ts:152`.

## 3. Verification (universal gate + payroll-specific)

1. Boot log shows registration success on the FIRST attempt — a retry loop here means the
   token identity is wrong (re-mint, step P5).
2. NL time-entry correction end-to-end: the request carries a tool call, the correction
   applies, and the ledger row shows `payroll_nl_correction` with tool usage tokens.
3. Support chat serves from the local model.
4. Negative check: try to save a `payroll_nl_correction` policy against a no-tools model —
   the console must refuse (capability gate), not save-and-fail-later.
5. Confirm zero cloud egress for this app: audit log has no scrub/cloud events for either
   class; Dashboard `zeroCloud` stays true if the firm is local-only.
