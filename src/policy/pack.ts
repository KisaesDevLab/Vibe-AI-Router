/**
 * Default policy pack (7.10): sensible local-first defaults for every known Vibe task class,
 * applied on firm creation. Sensitivity assignments here are the compliance-critical artifact —
 * they are mirrored in SENSITIVITY-REVIEW.md and are ITEM #1 on the Phase 15 agenda.
 * Rule until reviewed: when in doubt, local_only.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { models, policies, taskClasses } from '../../db/schema.js';
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
  // ── Vibe Payroll ──────────────────────────────────────────────────────────
  {
    key: 'payroll_anomaly_review',
    app: 'vibe-payroll',
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
    defaultMaxTokens: 4096,
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
];

/** Pick the best default model for a pack entry: local first, capability-valid, largest ctx. */
function pickDefaultModel(
  entries: (typeof models.$inferSelect)[],
  entry: PackEntry,
): typeof models.$inferSelect | undefined {
  const capable = entries.filter((m) => {
    if (m.status !== 'active') return false;
    const caps = effectiveCapabilities(m);
    if (entry.requires.tools && !caps.tools) return false;
    if (entry.requires.json_schema && !caps.json_schema) return false;
    if (entry.requires.vision && !caps.vision) return false;
    return true;
  });
  const pool =
    entry.sensitivity === 'local_only' ? capable.filter((m) => m.providerKind === 'local') : capable;
  // local-first even for cloud-permitted classes (principle 2)
  const locals = pool.filter((m) => m.providerKind === 'local');
  const pick = (list: typeof pool): typeof pool[number] | undefined =>
    [...list].sort((a, b) => b.contextWindow - a.contextWindow)[0];
  return pick(locals) ?? pick(pool);
}

export interface ApplyPackResult {
  classesCreated: number;
  policiesCreated: number;
  unresolved: string[]; // classes with no capable model — left without policy (fail closed)
}

export async function applyDefaultPack(db: Db, firmId: string): Promise<ApplyPackResult> {
  const allModels = await db.query.models.findMany();
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

    const model = pickDefaultModel(allModels, entry);
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
