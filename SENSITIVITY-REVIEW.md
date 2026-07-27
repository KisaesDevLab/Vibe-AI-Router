# SENSITIVITY-REVIEW.md — task-class data-tier assignments

**✅ REVIEWED — Phase 15B, 2026-07-27.** Kurt reviewed every row in the Q&A session:
**all 14 assignments KEPT as built** (items 1a `taxresearch_chat` cloud_allowed and 1b
doc-extract cloud_deidentified explicitly confirmed). Mirrors `src/policy/pack.ts` (enforced).
Future tier changes happen in the admin console (audited) — update this table when they do.

Tiers: **local_only** — never leaves the appliance. **cloud_deidentified** — cloud permitted
only after the deterministic scrubber passes (redact mode default per Q-056; block available
per firm). **cloud_allowed** — cloud permitted without scrubbing (prompts contain no client
data by construction).

| App | Task class | Sensitivity | Rationale | Review |
| --- | --- | --- | --- | --- |
| vibe-tb | `tb_classification` | **local_only** | Full client GL account names/balances; highest volume; local tier proven here | ✅ KEEP |
| vibe-tb | `tb_doc_extract` | **cloud_deidentified** | Source docs may carry TINs/account numbers — scrubber must clear before cloud | ✅ KEEP |
| vibe-tb | `tb_research_summary` | **cloud_allowed** | Public authority text only; no client data in prompt by construction | ✅ KEEP |
| vibe-1099 | `v1099_payee_match` | **local_only** | Payee names + partial TINs inherently identifying | ✅ KEEP |
| vibe-1099 | `v1099_w9_extract` | **local_only** | W-9s contain full TINs by definition; scrubbing would destroy the payload | ✅ KEEP |
| vibe-1099 | `v1099_correspondence` | **cloud_deidentified** | Letter drafting benefits from stronger models; identifiers scrub cleanly | ✅ KEEP |
| vibe-mybooks | `mybooks_txn_categorize` | **local_only** | Bank descriptors carry account fragments + payee identity; high volume | ✅ KEEP |
| vibe-mybooks | `mybooks_receipt_extract` | **cloud_deidentified** | Receipts rarely carry TINs; card numbers Luhn-scrubbed | ✅ KEEP |
| vibe-payroll | `payroll_anomaly_review` | **local_only** | Wages + SSNs are the definition of local-only data | ✅ KEEP |
| vibe-tax-research | `taxresearch_chat` | **cloud_allowed** | Public-guidance RAG; app-side prompt discipline keeps client facts out — **verify this claim in review** | ✅ KEEP |
| vibe-tax-research | `taxresearch_memo_draft` | **cloud_deidentified** | Memos name clients/facts — scrub before cloud drafting | ✅ KEEP |
| vibe-connect | `connect_doc_summarize` | **local_only** | Arbitrary client uploads — assume identifying content | ✅ KEEP |
| vibe-tx-converter | `txconv_statement_parse` | **local_only** | Full bank statements: account numbers throughout | ✅ KEEP |
| vibe-time-billing | `tb_invoice_narrative` | **cloud_deidentified** | WIP narratives name clients/matters; scrub then draft | ✅ KEEP |

Registration-time rule (enforced in `src/policy/registration.ts`): a task class an app registers
that is NOT in this pack is created **local_only**, and registration can never widen an
existing class's sensitivity — only the admin surface can, deliberately.

Reviewed 2026-07-27: all rows KEEP (Phase 15B Q&A).
