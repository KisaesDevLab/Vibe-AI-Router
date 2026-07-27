/**
 * Seed (Phase 1.15): demo firm, admin user, local Ollama provider, 3 task classes,
 * 5 fixture models with pricing, one policy per task class, and a demo app token.
 * Idempotent — safe to re-run; every insert upserts on its natural key.
 */
import { createHash } from 'node:crypto';
import { eq, sql as dsql } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import {
  appTokens,
  firms,
  modelPricing,
  models,
  policies,
  providers,
  taskClasses,
  users,
} from './schema.js';

export const DEMO = {
  firmSlug: 'demo-firm',
  adminEmail: 'admin@demo.firm',
  appToken: 'vibe-tb-demo-token', // plaintext printed at seed time; only the hash is stored
} as const;

export async function seed(databaseUrl: string, log: (m: string) => void = () => {}): Promise<void> {
  const { db, close } = createDb(databaseUrl, 2);
  try {
    // firm
    const [firm] = await db
      .insert(firms)
      .values({
        name: 'Demo Firm CPA',
        slug: DEMO.firmSlug,
        settings: { scrubber_mode: 'block' },
      })
      .onConflictDoUpdate({ target: firms.slug, set: { name: 'Demo Firm CPA' } })
      .returning();
    if (!firm) throw new Error('firm upsert returned nothing');

    // admin user
    await db
      .insert(users)
      .values({ firmId: firm.id, role: 'admin', email: DEMO.adminEmail, displayName: 'Demo Admin' })
      .onConflictDoUpdate({ target: users.email, set: { displayName: 'Demo Admin' } });

    // local provider (Ollama / vibellm)
    const existingProvider = await db.query.providers.findFirst({
      where: (p, { and, eq: eq_ }) => and(eq_(p.firmId, firm.id), eq_(p.label, 'Local (vibellm)')),
    });
    const provider =
      existingProvider ??
      (
        await db
          .insert(providers)
          .values({
            firmId: firm.id,
            kind: 'local',
            label: 'Local (vibellm)',
            baseUrl: 'http://vibellm:11434/v1',
            authType: 'none',
          })
          .returning()
      )[0];
    if (!provider) throw new Error('provider upsert returned nothing');

    // fixture models + pricing ($/MTok; local = 0.00, explicitly priced so cost is 0, not unknown)
    const fixtures = [
      {
        canonicalId: 'ollama/qwen3:14b',
        providerKind: 'local' as const,
        displayName: 'Qwen3 14B (local)',
        contextWindow: 32768,
        maxOutput: 8192,
        capabilities: { tools: true, json_schema: true },
        pricing: { input: '0', output: '0' },
      },
      {
        canonicalId: 'ollama/llama3.2-vision:11b',
        providerKind: 'local' as const,
        displayName: 'Llama 3.2 Vision 11B (local)',
        contextWindow: 131072,
        maxOutput: 8192,
        capabilities: { vision: true },
        pricing: { input: '0', output: '0' },
      },
      {
        canonicalId: 'anthropic/claude-sonnet-4-5',
        providerKind: 'anthropic' as const,
        displayName: 'Claude Sonnet 4.5',
        contextWindow: 200000,
        maxOutput: 64000,
        capabilities: { tools: true, json_schema: true, vision: true, caching: true, reasoning: true },
        pricing: { input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75' },
      },
      {
        canonicalId: 'anthropic/claude-haiku-4-5',
        providerKind: 'anthropic' as const,
        displayName: 'Claude Haiku 4.5',
        contextWindow: 200000,
        maxOutput: 64000,
        capabilities: { tools: true, json_schema: true, vision: true, caching: true },
        pricing: { input: '1', output: '5', cacheRead: '0.1', cacheWrite: '1.25' },
      },
      {
        canonicalId: 'openai/gpt-4o-mini',
        providerKind: 'openai_compat' as const,
        displayName: 'GPT-4o mini',
        contextWindow: 128000,
        maxOutput: 16384,
        capabilities: { tools: true, json_schema: true, vision: true },
        pricing: { input: '0.15', output: '0.6', cacheRead: '0.075' },
      },
    ];

    const modelIds = new Map<string, string>();
    for (const f of fixtures) {
      const [m] = await db
        .insert(models)
        .values({
          canonicalId: f.canonicalId,
          providerKind: f.providerKind,
          displayName: f.displayName,
          contextWindow: f.contextWindow,
          maxOutput: f.maxOutput,
          capabilities: f.capabilities,
          source: 'custom',
        })
        .onConflictDoUpdate({ target: models.canonicalId, set: { displayName: f.displayName } })
        .returning();
      if (!m) throw new Error(`model upsert returned nothing: ${f.canonicalId}`);
      modelIds.set(f.canonicalId, m.id);

      const priced = await db.select().from(modelPricing).where(eq(modelPricing.modelId, m.id));
      if (priced.length === 0) {
        await db.insert(modelPricing).values({
          modelId: m.id,
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          inputPerMtok: f.pricing.input,
          outputPerMtok: f.pricing.output,
          cacheReadPerMtok: 'cacheRead' in f.pricing ? f.pricing.cacheRead : null,
          cacheWritePerMtok: 'cacheWrite' in f.pricing ? (f.pricing as { cacheWrite: string }).cacheWrite : null,
        });
      }
    }

    // task classes (demo tiers: one per sensitivity)
    const classes = [
      {
        key: 'tb_classification',
        app: 'vibe-tb',
        description: 'Trial-balance account classification',
        sensitivity: 'local_only' as const,
        requires: { json_schema: true },
        defaultMaxTokens: 2048,
        defaultModel: 'ollama/qwen3:14b',
        allowed: ['ollama/qwen3:14b'],
        fallback: [],
      },
      {
        key: 'tb_doc_extract',
        app: 'vibe-tb',
        description: 'Source-document field extraction (scrubbed before cloud)',
        sensitivity: 'cloud_deidentified' as const,
        requires: { json_schema: true, vision: true },
        defaultMaxTokens: 4096,
        defaultModel: 'openai/gpt-4o-mini',
        allowed: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4-5'],
        fallback: ['anthropic/claude-sonnet-4-5'],
      },
      {
        key: 'tb_research_summary',
        app: 'vibe-tb',
        description: 'Public-guidance research summarization (no client data)',
        sensitivity: 'cloud_allowed' as const,
        requires: {},
        defaultMaxTokens: 8192,
        defaultModel: 'anthropic/claude-sonnet-4-5',
        allowed: ['anthropic/claude-sonnet-4-5', 'anthropic/claude-haiku-4-5'],
        fallback: ['anthropic/claude-haiku-4-5'],
      },
    ];

    for (const c of classes) {
      const [tc] = await db
        .insert(taskClasses)
        .values({
          key: c.key,
          app: c.app,
          description: c.description,
          sensitivity: c.sensitivity,
          requires: c.requires,
          defaultMaxTokens: c.defaultMaxTokens,
          registeredByAppVersion: 'seed',
        })
        .onConflictDoUpdate({ target: taskClasses.key, set: { description: c.description } })
        .returning();
      if (!tc) throw new Error(`task class upsert returned nothing: ${c.key}`);

      const defaultModelId = modelIds.get(c.defaultModel);
      if (!defaultModelId) throw new Error(`unknown default model ${c.defaultModel}`);
      const allowedIds = c.allowed.map((id) => {
        const v = modelIds.get(id);
        if (!v) throw new Error(`unknown allowed model ${id}`);
        return v;
      });
      const fallbackIds = c.fallback.map((id) => {
        const v = modelIds.get(id);
        if (!v) throw new Error(`unknown fallback model ${id}`);
        return v;
      });

      await db
        .insert(policies)
        .values({
          firmId: firm.id,
          taskClassId: tc.id,
          defaultModelId,
          allowedModelIds: allowedIds,
          fallbackChain: fallbackIds,
        })
        .onConflictDoUpdate({
          target: [policies.firmId, policies.taskClassId],
          set: { defaultModelId, allowedModelIds: allowedIds, fallbackChain: fallbackIds },
        });
    }

    // demo app token (hash only)
    const tokenHash = createHash('sha256').update(DEMO.appToken).digest('hex');
    await db
      .insert(appTokens)
      .values({ firmId: firm.id, app: 'vibe-tb', tokenHash, scopes: ['chat'] })
      .onConflictDoUpdate({ target: appTokens.tokenHash, set: { revokedAt: dsql`NULL` } });

    log(`seeded firm=${DEMO.firmSlug} admin=${DEMO.adminEmail} app-token=${DEMO.appToken}`);
  } finally {
    await close();
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('seed.ts') || entry.endsWith('seed.js')) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(1);
  }
  await seed(url, (m) => process.stdout.write(m + '\n'));
}
