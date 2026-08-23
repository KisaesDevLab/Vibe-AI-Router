# SENSITIVITY-REVIEW.md — task-class data-tier assignments

**✅ REVIEWED — Phase 15B, 2026-07-27.** Kurt reviewed every row in the Q&A session:
**all 14 original assignments KEPT as built** (items 1a `taxresearch_chat` cloud_allowed and 1b
doc-extract cloud_deidentified explicitly confirmed). Mirrors `src/policy/pack.ts` (enforced).
Future tier changes happen in the admin console (audited) — update this table when they do.

**⏳ 8 rows added 2026-08-09 (Q-081) — PENDING review.** The MyBooks/Time-Billing repo AI-task
audit surfaced 8 task classes that apps registered at boot but were absent from the curated
pack. They are now pack entries, all **local_only** — the safest defensible default, identical
to what runtime registration produced (no egress-behavior change). Four are **cloud-candidates**
(parallels of already-cloud classes) an operator may widen after review: `mybooks_bill_extract`
(parallels the cloud `mybooks_receipt_extract`), `mybooks_vendor_enrich`,
`mybooks_report_narrative`, and — with app-side prompt discipline — `timebill_practice_analytics`.
Widening is a deliberate, audited admin action; until then they stay local.

**1 row added 2026-08-23 (Q-086), reviewed same day (Q-087).** Time & Billing 0223 added AI
file naming: `timebill_file_naming` sends the first pages of client-uploaded documents (text or
page images) to a vision + json_schema model. Added local_only (Q-086); Kurt widened it to
**cloud_deidentified** the same day (Q-087) to make DigitalOcean Gradient vision models
(kimi-k2.5/2.6) usable alongside the local tier. Recorded with the caveat: the scrubber redacts
*text* parts only — image parts reach a cloud model unscrubbed, so this widening carries the
same accepted exposure as `mybooks_receipt_extract`. Defaults remain local-first; DO models are
an explicit policy binding.

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
| vibe-mybooks | `mybooks_bill_extract` | **local_only** | Vendor bills carry account numbers + occasional TINs | ⏳ NEW (Q-081) — cloud-candidate (parallels `mybooks_receipt_extract`) |
| vibe-mybooks | `mybooks_doc_classify` | **local_only** | Classifier sees full statement/check images with account numbers | ⏳ NEW (Q-081) |
| vibe-mybooks | `mybooks_statement_extract` | **local_only** | Full bank statements + check reads: account numbers throughout | ⏳ NEW (Q-081) |
| vibe-mybooks | `mybooks_vendor_enrich` | **local_only** | Payee/merchant names mildly identifying | ⏳ NEW (Q-081) — cloud-candidate |
| vibe-mybooks | `mybooks_chat` | **local_only** | Support/bookkeeping assistant can surface live client ledger data | ⏳ NEW (Q-081) |
| vibe-mybooks | `mybooks_report_narrative` | **local_only** | Names clients + financials | ⏳ NEW (Q-081) — cloud-candidate |
| vibe-payroll | `payroll_anomaly_review` | **local_only** | Wages + SSNs are the definition of local-only data | ✅ KEEP |
| vibe-tax-research | `taxresearch_chat` | **cloud_allowed** | Public-guidance RAG; app-side prompt discipline keeps client facts out — **verify this claim in review** | ✅ KEEP |
| vibe-tax-research | `taxresearch_memo_draft` | **cloud_deidentified** | Memos name clients/facts — scrub before cloud drafting | ✅ KEEP |
| vibe-connect | `connect_doc_summarize` | **local_only** | Arbitrary client uploads — assume identifying content | ✅ KEEP |
| vibe-tx-converter | `txconv_statement_parse` | **local_only** | Full bank statements: account numbers throughout | ✅ KEEP |
| vibe-time-billing | `tb_invoice_narrative` | **cloud_deidentified** | WIP narratives name clients/matters; scrub then draft | ✅ KEEP |
| vibe-time-billing | `timebill_practice_analytics` | **local_only** | Internal billing/practice metrics with client + engagement names | ⏳ NEW (Q-081) |
| vibe-time-billing | `timebill_support_chat` | **local_only** | KB-grounded support chat can surface firm data | ⏳ NEW (Q-081) |
| vibe-time-billing | `timebill_file_naming` | **cloud_deidentified** | Client document first pages (vision); text scrubbed, image parts pass unscrubbed (receipt-extract parallel) | ✅ WIDENED (Q-087, Kurt 2026-08-23) |

Registration-time rule (enforced in `src/policy/registration.ts`): a task class an app registers
that is NOT in this pack is created **local_only**, and registration can never widen an
existing class's sensitivity — only the admin surface can, deliberately.

Reviewed 2026-07-27: all rows KEEP (Phase 15B Q&A).
