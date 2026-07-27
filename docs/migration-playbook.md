# App migration playbook (12.6)

Distilled from the Vibe TB migration prep (12.4/12.5). One app at a time; the router is
already serving — migration is purely app-side.

## Per-app checklist

1. **Enumerate call sites.** `grep -rE 'openai|anthropic|ollama|11434|api\.openai|/v1/chat'`
   in the app repo. Every hit is either an AI call site or dead code — list both.
2. **Map to task classes.** Each distinct purpose → one task-class key (`<app>_<purpose>`).
   Check SENSITIVITY-REVIEW.md; a new key starts local_only until the admin widens it.
3. **Add the SDK.** `pnpm add @kisaes/vibe-ai-client`. Remove provider SDK deps
   (`openai`, `@anthropic-ai/sdk`, raw fetch wrappers) in the same PR — no lingering escape
   hatches.
4. **Register at boot.** `registerTaskClasses` in app startup (idempotent).
5. **Swap call sites** behind a feature flag (`AI_VIA_ROUTER=1` default on):
   - direct path retained until Phase 15 sign-off, then deleted;
   - thread `userId/userRole/engagementRef/clientRef` — this is what makes the ledger and
     T&B cost recovery work.
6. **Shadow-validate** (see below): run both paths on fixture data, diff outputs, attach the
   report to the migration PR.
7. **Verify ledger.** After the swap, run the app's AI feature once and confirm the row in
   Admin UI → Dashboard/Audit with the right app/task class/client dims.
8. **Provision the token.** Mint in Admin UI → App tokens; set `VIBE_AI_ROUTER_URL` +
   `VIBE_AI_TOKEN` in the app's appliance env template.

## Shadow validation (12.5)

`pnpm tsx scripts/shadow-diff.ts` runs every fixture prompt through BOTH paths:

- **direct**: straight to the model endpoint (the app's old behavior),
- **router**: through the router via the SDK (same model per policy),

then writes `SHADOW-DIFF-REPORT.md` with the match rate and divergence samples (SHA-256
hashes, never bodies). Fixtures: `data/shadow-fixtures.json` (TB classification corpus).
Run it on the appliance against live vibellm for the real report; CI runs it against a
deterministic mock to prove the harness itself.

Divergence guidance: with temperature 0 and identical model+prompt, expect ≥99% exact-match;
structured-output (json_schema) classes should reach 100% on the decoded object even when raw
text differs in whitespace.

## Vibe TB (first migration, 12.4) — status

The router-side work is DONE (task classes, policy, SDK, harness). The TB-repo swap itself is
staged as a Phase-15-gated change: apply steps 1–8 to `trial-balance-app` using task classes
`tb_classification` / `tb_doc_extract` / `tb_research_summary` (already in the default pack),
run the shadow report against live vibellm, retire the direct path after sign-off (Q-047,
plan 15.8).
