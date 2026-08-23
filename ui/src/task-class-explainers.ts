/**
 * Plain-language explanations of what each known task class actually DOES inside its app —
 * the registered `description` is a short label ("Uploaded-document type classification"),
 * which doesn't tell an operator what workflow the calls belong to. Sourced from the default
 * pack (src/policy/pack.ts) and the per-app integration runbooks (docs/integration-plans/).
 * Unknown/custom classes fall back to the registered description in the UI.
 */
export const TASK_CLASS_EXPLAINERS: Record<string, string> = {
  // ── Vibe Trial Balance ────────────────────────────────────────────────────
  tb_classification:
    'When a trial balance is imported, each GL account (name + balance) is sent to the model to be assigned its financial-statement classification (asset, liability, revenue, …). Works on the account list itself — it never sees documents.',
  tb_doc_extract:
    'Reads source documents the preparer attaches to workpapers (PDFs/images) and extracts structured fields from them.',
  tb_research_summary:
    'Summarizes public accounting and tax guidance for the preparer. Prompts contain public authority text only — no client data by construction.',
  tb_bank_statement_extract:
    'Parses bank-statement text into structured transaction rows for trial-balance workpapers.',
  tb_support_chat: 'The in-app help assistant for Trial Balance users.',
  tb_diagnostics:
    'Explains diagnostic findings in the trial balance (imbalances, unusual entries) in plain language for the preparer.',
  // ── Vibe 1099 ─────────────────────────────────────────────────────────────
  v1099_payee_match:
    'During 1099 preparation, decides whether vendor/payee records refer to the same entity ("Acme LLC" vs "ACME Inc") and assists deduplication.',
  v1099_w9_extract:
    'Reads uploaded W-9 forms and extracts name, TIN, address, and entity type into the payee record.',
  v1099_correspondence:
    'Drafts recipient letters and emails — e.g. missing-W-9 requests or B-notice correspondence.',
  // ── Vibe MyBooks ──────────────────────────────────────────────────────────
  mybooks_txn_categorize:
    'Assigns each imported bank-feed transaction to a chart-of-accounts category from its bank descriptor and amount. This is the class that categorizes transactions.',
  mybooks_receipt_extract:
    'Reads receipt and invoice images and extracts vendor, date, amount, and tax fields to create the expense entry.',
  mybooks_bill_extract:
    'Reads vendor bill / invoice documents and extracts the fields needed to create the bill in accounts payable.',
  mybooks_doc_classify:
    'Looks at each document uploaded to MyBooks and decides what KIND it is — receipt, vendor bill, bank statement, check, or other — so the app can route it to the right extraction pipeline (receipt, bill, or statement extract). It does not clean or categorize transactions; that is mybooks_txn_categorize.',
  mybooks_statement_extract:
    'Reads bank-statement pages and check images and extracts the transaction lines / check fields as structured JSON. Large output cap so multi-page statements are not truncated mid-array.',
  mybooks_vendor_enrich:
    'Normalizes raw bank/merchant descriptors into clean vendor names (e.g. "AMZN MKTP US*2X4" → Amazon) and enriches vendor records.',
  mybooks_chat:
    'The bookkeeping assistant chat inside MyBooks. It can surface live company and ledger data in its answers.',
  mybooks_report_narrative:
    'Writes the narrative text sections of client-facing financial reports.',
  // ── Vibe Payroll ──────────────────────────────────────────────────────────
  payroll_anomaly_review:
    'Generates the reviewer-facing narrative for payroll-run anomaly detection (unusual hours, pay spikes). Note: the current app version does not call this class (see the payroll runbook).',
  payroll_nl_correction:
    'Turns a natural-language instruction ("set Maria’s Tuesday to 6 hours") into structured timesheet corrections via tool calls.',
  payroll_support_chat: 'The in-app help assistant for Payroll & Time users.',
  // ── Vibe Tax Research Chat ────────────────────────────────────────────────
  taxresearch_chat:
    'The interactive research chat over public tax authority — retrieval-augmented, using tool calls to search and fetch sources.',
  taxresearch_memo_draft:
    'Drafts client memos from a research thread’s findings; memos name clients and facts, so drafts are scrubbed before any cloud model sees them.',
  taxresearch_content_meta:
    'Generates metadata for research content — titles, summaries, and tags.',
  taxresearch_authoring: 'Assists staff authoring knowledge-base and research content.',
  // ── Vibe Connect ──────────────────────────────────────────────────────────
  connect_doc_summarize:
    'Summarizes documents that clients upload through the portal so staff can triage them.',
  // ── Vibe Transaction Convertor ────────────────────────────────────────────
  txconv_statement_parse:
    'Detects the structure of an imported bank statement (columns, date formats, sections) and extracts its transactions as structured JSON for conversion. Large output cap for multi-page statements.',
  txconv_enrichment:
    'Enriches parsed transactions — payee normalization and category hints — after statement parsing.',
  txconv_check_resolve: 'Resolves check numbers and payees from parsed statement data.',
  // ── Vibe Time & Billing ───────────────────────────────────────────────────
  tb_invoice_narrative:
    'Polishes raw WIP/time-entry descriptions into client-ready invoice line narratives.',
  timebill_practice_analytics:
    'Generates narrative insights and answers natural-language questions over practice analytics — realization, pricing, capacity, and anomalies.',
  timebill_support_chat:
    'The KB-grounded support chat for staff and the client portal; also parses report parameters from natural language.',
  timebill_file_naming:
    'Looks at the first pages of a client-uploaded document (text or page images) and proposes a filename following the firm’s naming pattern, returned as structured JSON. Needs a vision + JSON-schema capable model; document images bypass the text scrubber, so widening beyond local means the raw pages reach the cloud model.',
};
