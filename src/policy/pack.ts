/**
 * Default policy pack (7.10): sensible local-first defaults for every known Vibe task class,
 * applied on firm creation. Sensitivity assignments here are the compliance-critical artifact —
 * they are mirrored in SENSITIVITY-REVIEW.md and are ITEM #1 on the Phase 15 agenda.
 * Rule until reviewed: when in doubt, local_only.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { isLocalKind, models, policies, taskClasses } from '../../db/schema.js';
import { effectiveCapabilities } from '../catalog/service.js';
import type { TaskClassRequires } from './engine.js';

export interface PackEntry {
  key: string;
  app: string;
  description: string;
  sensitivity: 'local_only' | 'cloud_deidentified' | 'cloud_allowed';
  requires: TaskClassRequires;
  defaultMaxTokens: number;
  rationale: string;
}

export const DEFAULT_PACK: PackEntry[] = [
  // ── Vibe Trial Balance ────────────────────────────────────────────────────
  {
    key: 'tb_classification',
    app: 'vibe-tb',
    description: 'Trial-balance account classification',
    sensitivity: 'local_only',
    requires: { json_schema: true },
    defaultMaxTokens: 2048,
    rationale: 'Full client GL account names/balances; highest volume; local tier is proven here.',
  },
  {
    key: 'tb_doc_extract',
    app: 'vibe-tb',
    description: 'Source-document field extraction',
    sensitivity: 'cloud_deidentified',
    requires: { json_schema: true, vision: true },
    defaultMaxTokens: 4096,
    rationale: 'Documents may carry TINs/account numbers — scrubber must clear before cloud.',
  },
  {
    key: 'tb_research_summary',
    app: 'vibe-tb',
    description: 'Public-guidance research summarization',
    sensitivity: 'cloud_allowed',
    requires: {},
    defaultMaxTokens: 8192,
    rationale: 'Public authority text only; no client data enters the prompt by construction.',
  },
  // ── Vibe 1099 ─────────────────────────────────────────────────────────────
  {
    key: 'v1099_payee_match',
    app: 'vibe-1099',
    description: 'Vendor/payee record matching + dedupe assistance',
    sensitivity: 'local_only',
    requires: { json_schema: true },
    defaultMaxTokens: 2048,
    rationale: 'Payee names + partial TINs are inherently identifying; must stay local.',
  },
  {
    key: 'v1099_w9_extract',
    app: 'vibe-1099',
    description: 'W-9 field extraction',
    sensitivity: 'local_only',
    requires: { json_schema: true, vision: true },
    defaultMaxTokens: 2048,
    rationale: 'W-9s contain full TINs by definition — scrubbing would destroy the payload.',
  },
  {
    key: 'v1099_correspondence',
    app: 'vibe-1099',
    description: 'Recipient correspondence drafting',
    sensitivity: 'cloud_deidentified',
    requires: {},
    defaultMaxTokens: 2048,
    rationale: 'Letter drafting benefits from stronger models; identifiers scrub cleanly.',
  },
  // ── Vibe MyBooks ──────────────────────────────────────────────────────────
  {
    key: 'mybooks_txn_categorize',
    app: 'vibe-mybooks',
    description: 'Bank transaction categorization',
    sensitivity: 'local_only',
    requires: { json_schema: true },
    defaultMaxTokens: 2048,
    rationale: 'Bank descriptors carry account fragments and payee identities; high volume.',
  },
  {
    key: 'mybooks_receipt_extract',
    app: 'vibe-mybooks',
    description: 'Receipt/invoice OCR field extraction',
    sensitivity: 'cloud_deidentified',
    requires: { json_schema: true, vision: true },
    defaultMaxTokens: 4096,
    rationale: 'Receipts rarely carry TINs; card numbers are Luhn-scrubbed before egress.',
  },
  // Registered at boot by vibe-mybooks (Q-081); added to the pack so coverage no longer
  // depends on the boot-registration handshake and each class gets a reviewed tier + a
  // pre-provisioned policy on firm creation. All local_only = the safest defensible default
  // and identical to what runtime registration produced (no egress-behavior change). The
  // cloud-candidate classes are flagged for Phase-15 widening in SENSITIVITY-REVIEW.md.
  {
    key: 'mybooks_bill_extract',
    app: 'vibe-mybooks',
    description: 'Vendor bill / invoice field extraction',
    sensitivity: 'local_only',
    requires: { json_schema: true, vision: true },
    defaultMaxTokens: 4096,
    rationale: 'Vendor bills carry account numbers and occasional TINs; local until reviewed.',
  },
  {
    key: 'mybooks_doc_classify',
    app: 'vibe-mybooks',
    description: 'Uploaded-document type classification',
    sensitivity: 'local_only',
    requires: { json_schema: true, vision: true },
    defaultMaxTokens: 1024,
    rationale: 'Classifier sees full statement/check images with account numbers throughout.',
  },
  {
    key: 'mybooks_statement_extract',
    app: 'vibe-mybooks',
    description: 'Bank-statement / check field extraction',
    sensitivity: 'local_only',
    requires: { json_schema: true, vision: true },
    // full statements emit large JSON arrays; app registers 16384, raised to match
    // txconv_statement_parse so a low clamp can't truncate mid-array (Q-074)
    defaultMaxTokens: 32768,
    rationale: 'Full bank statements + check reads: account numbers + transaction detail throughout.',
  },
  {
    key: 'mybooks_vendor_enrich',
    app: 'vibe-mybooks',
    description: 'Merchant / vendor enrichment',
    sensitivity: 'local_only',
    requires: { json_schema: true },
    defaultMaxTokens: 1024,
    rationale: 'Payee/merchant names are mildly identifying; local until reviewed for cloud.',
  },
  {
    key: 'mybooks_chat',
    app: 'vibe-mybooks',
    description: 'Bookkeeping assistant / support chat',
    sensitivity: 'local_only',
    requires: {},
    defaultMaxTokens: 2048,
    rationale: 'Assistant can surface live client ledger/company data; conservative default.',
  },
  {
    key: 'mybooks_report_narrative',
    app: 'vibe-mybooks',
    description: 'Client-facing report narration',
    sensitivity: 'local_only',
    requires: {},
    defaultMaxTokens: 1024,
    rationale: 'Narration names clients + financials; local until reviewed for cloud drafting.',
  },
  // ── Vibe Payroll ──────────────────────────────────────────────────────────
  {
    key: 'payroll_anomaly_review',
    // matches the app's actual registration identity (vibe-payroll-time) — a token minted
    // under the old name made registration 403 forever (Q-074)
    app: 'vibe-payroll-time',
    description: 'Payroll run anomaly detection narrative',
    sensitivity: 'local_only',
    requires: { json_schema: true },
    defaultMaxTokens: 4096,
    rationale: 'Wages + SSNs are the definition of local-only data.',
  },
  // ── Vibe Tax Research Chat ────────────────────────────────────────────────
  {
    key: 'taxresearch_chat',
    app: 'vibe-tax-research',
    description: 'Interactive tax research chat over public authority',
    sensitivity: 'cloud_allowed',
    requires: { tools: true },
    defaultMaxTokens: 8192,
    rationale: 'Public-guidance RAG; app-side prompt discipline keeps client facts out.',
  },
  {
    key: 'taxresearch_memo_draft',
    app: 'vibe-tax-research',
    description: 'Client memo drafting from research threads',
    sensitivity: 'cloud_deidentified',
    requires: {},
    defaultMaxTokens: 8192,
    rationale: 'Memos name clients/facts — scrub before cloud drafting.',
  },
  // ── Vibe Connect ──────────────────────────────────────────────────────────
  {
    key: 'connect_doc_summarize',
    app: 'vibe-connect',
    description: 'Client-uploaded document summarization',
    sensitivity: 'local_only',
    requires: {},
    defaultMaxTokens: 4096,
    rationale: 'Uploads are arbitrary client documents — assume identifying content.',
  },
  // ── Vibe Transaction Convertor ────────────────────────────────────────────
  {
    key: 'txconv_statement_parse',
    app: 'vibe-tx-converter',
    description: 'Bank statement structure detection assistance',
    sensitivity: 'local_only',
    requires: { json_schema: true },
    // multi-page statement extraction emits large JSON arrays — the app requests 32k and a
    // 4096 clamp truncated extractions mid-array (Q-074); operators clamp down per policy
    defaultMaxTokens: 32768,
    rationale: 'Full statements: account numbers + transaction detail throughout.',
  },
  // ── Vibe Time & Billing ───────────────────────────────────────────────────
  {
    key: 'tb_invoice_narrative',
    app: 'vibe-time-billing',
    description: 'Invoice line narrative polish',
    sensitivity: 'cloud_deidentified',
    requires: {},
    defaultMaxTokens: 1024,
    rationale: 'WIP narratives name clients/matters; scrub then draft.',
  },
  // Registered at boot by vibe-time-billing (Q-081); added to the pack for the same reason as
  // the mybooks_* classes above. Both stay local_only — analytics + KB support run over
  // internal firm billing/practice data (client + engagement names, WIP amounts).
  {
    key: 'timebill_practice_analytics',
    app: 'vibe-time-billing',
    description: 'Practice analytics narratives + NL query (realization, pricing, capacity, anomalies)',
    sensitivity: 'local_only',
    requires: {},
    defaultMaxTokens: 600,
    rationale: 'Runs over internal firm billing/practice metrics with client + engagement names.',
  },
  {
    key: 'timebill_support_chat',
    app: 'vibe-time-billing',
    description: 'KB-grounded staff/portal support chat + report parameter parsing',
    sensitivity: 'local_only',
    requires: {},
    defaultMaxTokens: 1024,
    rationale: 'Assistant grounds on internal KB and can surface firm data; conservative default.',
  },
  // Registered at boot by vibe-time-billing 0223 (Q-086). Sends first-page images of
  // client-uploaded documents — the scrubber redacts text parts only, so images would reach a
  // cloud model unscrubbed if widened. Stays local_only until an operator deliberately widens.
  {
    key: 'timebill_file_naming',
    app: 'vibe-time-billing',
    description: 'Filename proposal from an uploaded document’s first pages (firm naming pattern)',
    sensitivity: 'local_only',
    requires: { vision: true, json_schema: true },
    defaultMaxTokens: 300,
    rationale:
      'Client document pages carry identifying content, and image parts bypass the scrubber.',
  },
];

/**
 * Pick the best default model for a pack entry: local first, capability-valid, largest ctx.
 *
 * `availableKinds` limits the pool to provider kinds the firm has ACTUALLY configured. On a
 * fresh appliance that is `local` only, so cloud-tier classes are left unconfigured rather
 * than pre-pointed at a model nothing can serve — "zero-cloud out of the box; cloud is always
 * a deliberate per-class admin choice" (Phase 15B). Without this, populating the catalog was
 * enough to auto-assign a cloud model to any class no local model could satisfy.
 */
function pickDefaultModel(
  entries: (typeof models.$inferSelect)[],
  entry: PackEntry,
  availableKinds: ReadonlySet<string>,
): typeof models.$inferSelect | undefined {
  const capable = entries.filter((m) => {
    if (m.status !== 'active') return false;
    if (!availableKinds.has(m.providerKind)) return false;
    const caps = effectiveCapabilities(m);
    if (entry.requires.tools && !caps.tools) return false;
    if (entry.requires.json_schema && !caps.json_schema) return false;
    if (entry.requires.vision && !caps.vision) return false;
    return true;
  });
  const pool =
    entry.sensitivity === 'local_only' ? capable.filter((m) => isLocalKind(m.providerKind)) : capable;
  // local-first even for cloud-permitted classes (principle 2)
  const locals = pool.filter((m) => isLocalKind(m.providerKind));
  // Operator-registered models (source 'custom' — e.g. "the model MY server actually serves",
  // written by the appliance bootstrap) always beat a synced catalog entry. Sorting purely by
  // context window used to pick whatever the feed listed as biggest, which is not a model the
  // appliance can serve. Context window breaks ties within each group.
  const pick = (list: typeof pool): (typeof pool)[number] | undefined =>
    [...list].sort((a, b) => {
      if (a.source !== b.source) return a.source === 'custom' ? -1 : 1;
      return b.contextWindow - a.contextWindow;
    })[0];
  return pick(locals) ?? pick(pool);
}

export interface ApplyPackResult {
  classesCreated: number;
  policiesCreated: number;
  unresolved: string[]; // classes with no capable model — left without policy (fail closed)
}

export async function applyDefaultPack(db: Db, firmId: string): Promise<ApplyPackResult> {
  const allModels = await db.query.models.findMany();
  // only provider kinds this firm has configured are eligible (see pickDefaultModel)
  const configured = await db.query.providers.findMany({
    where: (p, { and, eq, isNull }) => and(eq(p.firmId, firmId), isNull(p.deletedAt)),
  });
  const availableKinds = new Set(configured.map((p) => p.kind));
  const result: ApplyPackResult = { classesCreated: 0, policiesCreated: 0, unresolved: [] };

  for (const entry of DEFAULT_PACK) {
    let tc = await db.query.taskClasses.findFirst({ where: eq(taskClasses.key, entry.key) });
    if (!tc) {
      const [created] = await db
        .insert(taskClasses)
        .values({
          key: entry.key,
          app: entry.app,
          description: entry.description,
          sensitivity: entry.sensitivity,
          requires: entry.requires,
          defaultMaxTokens: entry.defaultMaxTokens,
          registeredByAppVersion: 'default-pack',
        })
        .returning();
      tc = created!;
      result.classesCreated++;
    }

    const existingPolicy = await db.query.policies.findFirst({
      where: (p, { and: and_, eq: eq_ }) => and_(eq_(p.firmId, firmId), eq_(p.taskClassId, tc.id)),
    });
    if (existingPolicy) continue;

    const model = pickDefaultModel(allModels, entry, availableKinds);
    if (!model) {
      // fail closed: no policy row → requests for this class are rejected until configured
      result.unresolved.push(entry.key);
      continue;
    }
    await db.insert(policies).values({
      firmId,
      taskClassId: tc.id,
      defaultModelId: model.id,
      allowedModelIds: [model.id],
      fallbackChain: [],
    });
    result.policiesCreated++;
  }
  return result;
}
