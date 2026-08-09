/**
 * WISP AI Data-Handling Appendix (14.7 / firm compliance). Generates a Microsoft Word .docx
 * the firm attaches to its Written Information Security Plan (FTC Safeguards Rule 16 CFR 314 /
 * IRS Pub 4557). Scope is strictly the AI-handling controls the router can state as FACT from
 * live config — an exhibit, not a standalone WISP; the firm's attorney owns the rest.
 *
 * Two layers: buildWispData() reads live, firm-scoped config into a plain object (pure,
 * unit-testable); renderWispDocx() turns it into the .docx buffer. Nothing here reads or emits
 * prompt/response content — the router never stores it (db/schema.ts:8).
 */
import { eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { firms, policies, providers, taskClasses } from '../../db/schema.js';
import { isLocalKind } from '../../db/schema.js';
import { MATCH_TYPES } from '../protect/scrub.js';

// ── data assembly ────────────────────────────────────────────────────────────

/** firm-friendly tier names (mirror docs/firm/where-your-data-goes.md) */
const TIER_LABEL = {
  local_only: 'LOCAL',
  cloud_deidentified: 'SCRUBBED',
  cloud_allowed: 'CLOUD',
} as const;

type Sensitivity = keyof typeof TIER_LABEL;

export interface WispProvider {
  label: string;
  kind: string;
  tier: 'local' | 'cloud';
  status: string;
}

export interface WispTaskClass {
  key: string;
  app: string;
  sensitivity: Sensitivity;
  tier: (typeof TIER_LABEL)[Sensitivity];
  /** the firm's configured default model, or null when no enabled policy binds it (fails closed) */
  servedBy: string | null;
  /** the enforced data-boundary statement for this tier */
  leavesAppliance: string;
}

export interface WispData {
  firmName: string;
  generatedAt: string;
  scrubberMode: 'block' | 'redact' | 'warn';
  zeroCloud: boolean;
  retentionDays: number | undefined;
  providers: WispProvider[];
  taskClasses: WispTaskClass[];
  matchTypes: readonly string[];
}

function leavesApplianceText(s: Sensitivity, scrubberMode: string): string {
  switch (s) {
    case 'local_only':
      return 'No — served on the appliance only; never transmitted off-network.';
    case 'cloud_deidentified':
      return `Only after automated screening (scrubber mode: ${scrubberMode}); a match is ${
        scrubberMode === 'block' ? 'blocked before any transmission' : 'redacted to a [TYPE] token before transmission'
      }.`;
    case 'cloud_allowed':
      return 'Yes — permitted to the firm-chosen provider; these tasks carry no client data by construction.';
  }
}

/**
 * Read the live, firm-scoped configuration into a WispData snapshot. Reflects admin tier edits
 * and provider changes (not just the static default pack), because it queries the actual
 * task_classes + policies + providers rows.
 */
export async function buildWispData(
  db: Db,
  firmId: string,
  retentionDays: number | undefined,
  now: Date = new Date(),
): Promise<WispData> {
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  const settings = (firm?.settings ?? {}) as { scrubber_mode?: 'block' | 'redact' | 'warn' };
  const scrubberMode = settings.scrubber_mode ?? 'redact';

  const providerRows = await db.query.providers.findMany({
    where: (p, { and: and_, eq: eq_ }) => and_(eq_(p.firmId, firmId), isNull(p.deletedAt)),
    orderBy: providers.label,
  });
  const wispProviders: WispProvider[] = providerRows.map((p) => ({
    label: p.label,
    kind: p.kind,
    tier: isLocalKind(p.kind) ? 'local' : 'cloud',
    status: p.status,
  }));
  const zeroCloud = wispProviders.every((p) => p.tier === 'local');

  // all task classes (global registry) + this firm's policy binding for each
  const classRows = await db.query.taskClasses.findMany({ orderBy: [taskClasses.app, taskClasses.key] });
  const policyRows = await db.query.policies.findMany({ where: eq(policies.firmId, firmId) });
  const policyByClass = new Map(policyRows.map((p) => [p.taskClassId, p]));
  const modelRows = await db.query.models.findMany();
  const modelById = new Map(modelRows.map((m) => [m.id, m]));

  const wispClasses: WispTaskClass[] = classRows.map((tc) => {
    const s = tc.sensitivity as Sensitivity;
    const policy = policyByClass.get(tc.id);
    const servedBy = policy && policy.enabled ? (modelById.get(policy.defaultModelId)?.canonicalId ?? null) : null;
    return {
      key: tc.key,
      app: tc.app,
      sensitivity: s,
      tier: TIER_LABEL[s],
      servedBy,
      leavesAppliance: leavesApplianceText(s, scrubberMode),
    };
  });

  return {
    firmName: firm?.name ?? 'the firm',
    generatedAt: now.toISOString().slice(0, 10),
    scrubberMode,
    zeroCloud,
    retentionDays,
    providers: wispProviders,
    taskClasses: wispClasses,
    matchTypes: MATCH_TYPES,
  };
}

// ── docx rendering ───────────────────────────────────────────────────────────

// imported lazily inside renderWispDocx so the (heavier) docx module only loads on export
type DocxModule = typeof import('docx');

function heading(docx: DocxModule, text: string, level: 1 | 2): InstanceType<DocxModule['Paragraph']> {
  const { Paragraph, HeadingLevel } = docx;
  return new Paragraph({ text, heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2 });
}

function para(docx: DocxModule, text: string, opts?: { italics?: boolean; bold?: boolean }): InstanceType<DocxModule['Paragraph']> {
  const { Paragraph, TextRun } = docx;
  return new Paragraph({
    children: [
      new TextRun({ text, ...(opts?.italics ? { italics: true } : {}), ...(opts?.bold ? { bold: true } : {}) }),
    ],
    spacing: { after: 120 },
  });
}

function bullet(docx: DocxModule, text: string): InstanceType<DocxModule['Paragraph']> {
  const { Paragraph, TextRun } = docx;
  return new Paragraph({ children: [new TextRun(text)], bullet: { level: 0 } });
}

function table(docx: DocxModule, header: string[], rows: string[][]): InstanceType<DocxModule['Table']> {
  const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, BorderStyle } = docx;
  const border = { style: BorderStyle.SINGLE, size: 2, color: 'BFBFBF' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (text: string, bold: boolean): InstanceType<DocxModule['TableCell']> =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text, bold, size: 18 })] })],
      margins: { top: 40, bottom: 40, left: 80, right: 80 },
      borders,
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: header.map((h) => cell(h, true)) }),
      ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) })),
    ],
  });
}

/** Render the WispData into a .docx buffer (Office Open XML). */
export async function renderWispDocx(data: WispData): Promise<Buffer> {
  const docx = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;

  const children: InstanceType<DocxModule['Paragraph']>[] | unknown[] = [];
  const push = (el: unknown): void => void (children as unknown[]).push(el);

  // 1 — title + disclaimer
  push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('AI Data-Handling Appendix')] }));
  push(para(docx, `Exhibit to the Written Information Security Plan of ${data.firmName}`, { bold: true }));
  push(para(docx, `Generated from live system configuration on ${data.generatedAt}.`));
  push(
    para(
      docx,
      'NOT LEGAL ADVICE. This appendix documents the AI data-handling controls enforced by the ' +
        "firm's Vibe AI Router as configured on the date above. It is intended as a factual exhibit " +
        'to the firm’s WISP (FTC Safeguards Rule, 16 CFR Part 314; IRS Publication 4557). Physical ' +
        'security, personnel, incident-response, and the designated Qualified Individual are covered ' +
        'by the firm’s primary WISP and are out of scope here. Have the firm’s attorney review.',
      { italics: true },
    ),
  );

  // 2 — control point
  push(heading(docx, '1. Single control point', 2));
  push(
    para(
      docx,
      'All AI features in the firm’s software route through one control point — the Vibe AI ' +
        'Router, running on the firm’s own appliance using the firm’s own AI-provider accounts. ' +
        'There is no intermediary AI service; the software vendor never receives firm or client data. ' +
        (data.zeroCloud
          ? 'This appliance is currently configured FULLY LOCAL: no cloud AI provider is enabled, so no AI task transmits data off the appliance.'
          : 'Data tiers below govern which tasks may transmit to a cloud provider and under what screening.'),
    ),
  );

  // 3 — data tiers
  push(heading(docx, '2. Data tiers by task', 2));
  push(
    para(
      docx,
      'Every AI task is assigned a data tier, enforced server-side by the router on every request ' +
        '(not by application good behavior). LOCAL never leaves the appliance; SCRUBBED may reach the ' +
        'firm’s cloud provider only after automated screening; CLOUD carries no client data by ' +
        'construction. "Not configured" tasks fail closed (no model is bound, so the request is refused).',
    ),
  );
  push(
    table(
      docx,
      ['Task', 'App', 'Tier', 'Served by', 'Leaves appliance?'],
      data.taskClasses.map((t) => [t.key, t.app, t.tier, t.servedBy ?? 'not configured (fails closed)', t.leavesAppliance]),
    ),
  );

  // 4 — providers
  push(heading(docx, '3. Configured AI providers', 2));
  if (data.providers.length === 0) {
    push(para(docx, 'No AI provider is configured. The appliance operates fully local.'));
  } else {
    push(
      para(
        docx,
        'Each provider is the firm’s own account with that vendor. Cloud providers are reachable only ' +
          'over HTTPS to public endpoints; local providers are pinned to the appliance network. Provider ' +
          'API keys are stored encrypted (see §5) and are never held by the applications.',
      ),
    );
    push(
      table(
        docx,
        ['Provider', 'Kind', 'Location', 'Health'],
        data.providers.map((p) => [p.label, p.kind, p.tier === 'local' ? 'On appliance (LAN)' : 'Cloud (firm account)', p.status]),
      ),
    );
  }

  // 5 — screening
  push(heading(docx, '4. Automated screening of cloud-bound data', 2));
  push(
    para(
      docx,
      `Before any SCRUBBED-tier request reaches a cloud provider, the router runs a deterministic, ` +
        `offline scan (no network) across all message text, including tool arguments. The current firm ` +
        `setting is scrubber mode = ${data.scrubberMode} (` +
        `${data.scrubberMode === 'block' ? 'a match blocks the request entirely' : data.scrubberMode === 'redact' ? 'a match is redacted to a [TYPE] token before transmission; there is no de-tokenization' : 'a match is logged as a warning'}).`,
    ),
  );
  push(para(docx, 'Detected identifier types:'));
  for (const t of data.matchTypes) push(bullet(docx, t.toUpperCase()));

  // 6 — encryption
  push(heading(docx, '5. Credential encryption', 2));
  push(
    para(
      docx,
      'Provider API keys are protected with envelope encryption (AES-256-GCM) under a per-appliance ' +
        'master key. No plaintext credential column exists, and there is no endpoint or path that reads ' +
        'a stored key back out — not even for an administrator.',
    ),
  );

  // 7 — retention & audit
  push(heading(docx, '6. Data retention & audit trail', 2));
  push(bullet(docx, 'Prompt and response CONTENT is never stored — not in logs, the database, or the audit trail. Enforced by automated tests on every release.'));
  push(bullet(docx, 'Stored metadata only: which app, which task, which model answered, token counts, cost, timestamps, and a one-way cryptographic hash used for correlation.'));
  push(
    bullet(
      docx,
      data.retentionDays !== undefined
        ? `Usage metadata is purged after ${data.retentionDays} days.`
        : 'Usage metadata is retained indefinitely (metadata only; no client content).',
    ),
  );
  push(bullet(docx, 'The audit log (every routing decision and configuration change) is append-only and immutable at the database level.'));

  // 8 — access control
  push(heading(docx, '7. Access control', 2));
  push(bullet(docx, 'Applications authenticate with scoped tokens and hold no provider keys — there is nothing for an application or its users to leak.'));
  push(bullet(docx, 'Tiers, model policies, budgets, and screening are enforced inside the router regardless of what any application or user requests.'));
  push(bullet(docx, 'Only a firm administrator can change data tiers or providers, in the console, and every change is recorded with before/after values in the immutable audit log.'));

  const doc = new Document({ sections: [{ children: children as InstanceType<DocxModule['Paragraph']>[] }] });
  return Packer.toBuffer(doc);
}
