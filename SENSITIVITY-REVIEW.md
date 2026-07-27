# SENSITIVITY-REVIEW.md — task-class data-tier assignments

**⚠️ PHASE 15 AGENDA ITEM #1.** This is the single most compliance-critical review artifact.
Every assignment below was made by the build agent under the rule *"when in doubt: local_only"*
and mirrors `src/policy/pack.ts` (enforced) — this file is the human-readable review copy.
Nothing here has been reviewed by Kurt yet.

Tiers: **local_only** — never leaves the appliance. **cloud_deidentified** — cloud permitted
only after the deterministic scrubber passes (block mode default). **cloud_allowed** — cloud
permitted without scrubbing (prompts contain no client data by construction).

| App | Task class | Sensitivity | Rationale | Review |
| --- | --- | --- | --- | --- |
| vibe-tb | `tb_classification` | **local_only** | Full client GL account names/balances; highest volume; local tier proven here | ☐ |
| vibe-tb | `tb_doc_extract` | **cloud_deidentified** | Source docs may carry TINs/account numbers — scrubber must clear before cloud | ☐ |
| vibe-tb | `tb_research_summary` | **cloud_allowed** | Public authority text only; no client data in prompt by construction | ☐ |
| vibe-1099 | `v1099_payee_match` | **local_only** | Payee names + partial TINs inherently identifying | ☐ |
| vibe-1099 | `v1099_w9_extract` | **local_only** | W-9s contain full TINs by definition; scrubbing would destroy the payload | ☐ |
| vibe-1099 | `v1099_correspondence` | **cloud_deidentified** | Letter drafting benefits from stronger models; identifiers scrub cleanly | ☐ |
| vibe-mybooks | `mybooks_txn_categorize` | **local_only** | Bank descriptors carry account fragments + payee identity; high volume | ☐ |
| vibe-mybooks | `mybooks_receipt_extract` | **cloud_deidentified** | Receipts rarely carry TINs; card numbers Luhn-scrubbed | ☐ |
| vibe-payroll | `payroll_anomaly_review` | **local_only** | Wages + SSNs are the definition of local-only data | ☐ |
| vibe-tax-research | `taxresearch_chat` | **cloud_allowed** | Public-guidance RAG; app-side prompt discipline keeps client facts out — **verify this claim in review** | ☐ |
| vibe-tax-research | `taxresearch_memo_draft` | **cloud_deidentified** | Memos name clients/facts — scrub before cloud drafting | ☐ |
| vibe-connect | `connect_doc_summarize` | **local_only** | Arbitrary client uploads — assume identifying content | ☐ |
| vibe-tx-converter | `txconv_statement_parse` | **local_only** | Full bank statements: account numbers throughout | ☐ |
| vibe-time-billing | `tb_invoice_narrative` | **cloud_deidentified** | WIP narratives name clients/matters; scrub then draft | ☐ |

Registration-time rule (enforced in `src/policy/registration.ts`): a task class an app registers
that is NOT in this pack is created **local_only**, and registration can never widen an
existing class's sensitivity — only the admin surface can, deliberately.

Review protocol per row: `KEEP` or `CHANGE: <tier> — <instruction>`.
