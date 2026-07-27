# Per-app migration tickets (14.9) — **ON HOLD per operator decision (Q-059)**

> 2026-07-27: Kurt — no app changes until the router has passed multiple QA rounds. QA rounds
> A/B/C are complete (QA-REPORT.md); the hold remains until explicit operator sign-off.

Template per docs/migration-playbook.md (8 steps). Effort assumes the playbook; task classes
already exist in the default pack unless noted.

| # | App | Task classes | Notes | Est. |
| --- | --- | --- | --- | --- |
| MIG-1 | **trial-balance-app (Vibe TB)** | tb_classification, tb_doc_extract, tb_research_summary | FIRST (12.4/Q-047). Highest volume, local tier. Run shadow-diff against live vibellm; retire direct path (15.8) | 0.5 d |
| MIG-2 | vibe-mybooks | mybooks_txn_categorize, mybooks_receipt_extract | Categorization is high-volume local; receipts need vision model in policy | 0.5 d |
| MIG-3 | Vibe-1099 | v1099_payee_match, v1099_w9_extract, v1099_correspondence | W-9 extraction is LOCAL by definition (full TINs) — never widen | 0.5 d |
| MIG-4 | Vibe-Tax-Research-Chat | taxresearch_chat, taxresearch_memo_draft | Needs embeddings/rerank endpoints for RAG — promote backlog item first if required | 1 d |
| MIG-5 | Vibe-Connect | connect_doc_summarize | Client uploads: LOCAL tier | 0.5 d |
| MIG-6 | Vibe-Transaction-Convertor | txconv_statement_parse | Coordinates with vibe-glm-ocr flows | 0.5 d |
| MIG-7 | Vibe-Payroll-Time | payroll_anomaly_review | SSNs+wages: LOCAL, never widen | 0.5 d |
| MIG-8 | Vibe-Time-Billing | tb_invoice_narrative | Also CONSUMES `/v1/billing/usage` for AI cost recovery — separate small feature | 1 d |

Common acceptance for every ticket: provider SDK deps deleted from the app repo; app token
provisioned in the appliance env template; task classes registered at boot; ledger rows carry
engagement/client refs; shadow-diff report attached where an old direct path existed.
