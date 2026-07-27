/**
 * Production first-run bootstrap (appliance install). Idempotent — safe to re-run.
 *
 * This is NOT `db/seed.ts`: the seed creates a demo firm with a published password and
 * fixture data for development. This creates the REAL firm, one admin login, the appliance's
 * own local model server as a provider, a catalog populated from the vendored pricing feed,
 * and the default (local-first) policy pack — nothing else, no demo rows.
 *
 * Env:
 *   DATABASE_URL            required
 *   ROUTER_ADMIN_EMAIL      required — the first admin login
 *   ROUTER_ADMIN_PASSWORD   required — generated + preserved by the appliance
 *   FIRM_NAME               default "Firm"
 *   LOCAL_MODEL_BASE_URL    default http://vibellm:11434/v1
 *   LOCAL_MODEL_ID          default ollama/qwen3:14b   (canonical id, family/native-name)
 *   LOCAL_MODEL_CONTEXT     default 32768
 *   LOCAL_MODEL_TOOLS       default 1   (does the served model support tool calling)
 *   LOCAL_MODEL_JSON_SCHEMA default 1   (…structured output)
 *   LOCAL_MODEL_VISION      default 0
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { firms, modelPricing, models, providers, users } from '../../db/schema.js';
import { hashPassword } from '../lib/password.js';
import { loadVendoredFeed, syncCatalog } from '../catalog/sync.js';
import { applyDefaultPack } from '../policy/pack.js';

const out = (m: string): void => void process.stdout.write(m + '\n');

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'firm'
  );
}

function flag(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return v === '1' || v.toLowerCase() === 'true';
}

export async function bootstrapFirm(databaseUrl: string): Promise<void> {
  const firmName = process.env['FIRM_NAME']?.trim() || 'Firm';
  const adminEmail = process.env['ROUTER_ADMIN_EMAIL']?.trim();
  const adminPassword = process.env['ROUTER_ADMIN_PASSWORD'];
  if (!adminEmail || !adminPassword) {
    throw new Error('ROUTER_ADMIN_EMAIL and ROUTER_ADMIN_PASSWORD are required');
  }
  // The login endpoint validates the email; creating an account whose address it would reject
  // yields an admin that can never sign in. Fail at INSTALL time instead, loudly.
  // (`admin@localhost` is the classic offender — no TLD.)
  if (!z.string().email().safeParse(adminEmail).success) {
    throw new Error(
      `ROUTER_ADMIN_EMAIL "${adminEmail}" is not a valid email address — the admin console ` +
        'would reject it at sign-in. Use a real address (or e.g. admin@appliance.local).',
    );
  }

  const localBaseUrl = process.env['LOCAL_MODEL_BASE_URL']?.trim() || 'http://vibellm:11434/v1';
  const localModelId = process.env['LOCAL_MODEL_ID']?.trim() || 'ollama/qwen3:14b';
  const localContext = Number(process.env['LOCAL_MODEL_CONTEXT'] ?? 32768);

  const { db, close } = createDb(databaseUrl, 2);
  try {
    // 1 — firm (single-firm appliance; the first firm row IS the firm)
    const existingFirm = await db.query.firms.findFirst();
    const firm =
      existingFirm ??
      (
        await db
          .insert(firms)
          .values({
            name: firmName,
            slug: slugify(firmName),
            // block is the strictest posture; redact is the shipped default (Q-056)
            settings: { scrubber_mode: 'redact' },
          })
          .returning()
      )[0];
    if (!firm) throw new Error('firm creation failed');
    out(`firm: ${firm.name} (${existingFirm ? 'existing' : 'created'})`);

    // 2 — admin login (password always re-applied so the appliance's generated value wins)
    const passwordHash = await hashPassword(adminPassword);
    const existingUser = await db.query.users.findFirst({ where: eq(users.email, adminEmail) });
    if (existingUser) {
      await db.update(users).set({ passwordHash, role: 'admin' }).where(eq(users.id, existingUser.id));
    } else {
      await db.insert(users).values({
        firmId: firm.id,
        role: 'admin',
        email: adminEmail,
        displayName: 'Administrator',
        passwordHash,
      });
    }
    out(`admin: ${adminEmail} (${existingUser ? 'password reset' : 'created'})`);

    // 3 — the appliance's own model server as the local provider (keyless, LAN-pinned)
    const existingProvider = await db.query.providers.findFirst({
      where: (p, { and, eq: eq_, isNull }) => and(eq_(p.kind, 'local'), isNull(p.deletedAt)),
    });
    if (existingProvider) {
      await db.update(providers).set({ baseUrl: localBaseUrl }).where(eq(providers.id, existingProvider.id));
    } else {
      await db.insert(providers).values({
        firmId: firm.id,
        kind: 'local',
        label: 'Local model server',
        baseUrl: localBaseUrl,
        authType: 'none',
      });
    }
    out(`local provider: ${localBaseUrl} (${existingProvider ? 'updated' : 'created'})`);

    // 4 — catalog from the vendored feed (offline-safe); non-fatal on failure
    try {
      const { feed, sha256 } = await loadVendoredFeed();
      const report = await syncCatalog(db, feed, { source: 'vendored:litellm', sourceSha256: sha256 });
      out(`catalog: +${report.added.length} models, ${report.pricingChanged.length} priced`);
    } catch (err) {
      out(`catalog sync skipped: ${err instanceof Error ? err.message : 'unknown'}`);
    }

    // 5 — the actual served local model as a custom entry. The feed cannot know which model
    // this appliance runs or what it supports, and local_only classes cannot resolve without
    // one. Explicit $0 pricing so local usage costs 0 rather than cost_unknown (Q-007).
    const existingModel = await db.query.models.findFirst({
      where: eq(models.canonicalId, localModelId),
    });
    const capabilities = {
      tools: flag('LOCAL_MODEL_TOOLS', true),
      json_schema: flag('LOCAL_MODEL_JSON_SCHEMA', true),
      vision: flag('LOCAL_MODEL_VISION', false),
    };
    let modelId: string;
    if (existingModel) {
      await db
        .update(models)
        .set({ contextWindow: localContext, capabilityOverrides: capabilities, status: 'active' })
        .where(eq(models.id, existingModel.id));
      modelId = existingModel.id;
    } else {
      const [row] = await db
        .insert(models)
        .values({
          canonicalId: localModelId,
          providerKind: 'local',
          displayName: localModelId.split('/').pop() ?? localModelId,
          contextWindow: localContext,
          capabilities,
          source: 'custom',
        })
        .returning();
      modelId = row!.id;
    }
    const priced = await db.query.modelPricing.findFirst({ where: eq(modelPricing.modelId, modelId) });
    if (!priced) {
      await db.insert(modelPricing).values({
        modelId,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        inputPerMtok: '0',
        outputPerMtok: '0',
      });
    }
    out(`local model: ${localModelId} ctx=${localContext} caps=${JSON.stringify(capabilities)}`);

    // 6 — default policy pack: local-first for every known Vibe task class
    const pack = await applyDefaultPack(db, firm.id);
    out(
      `policy pack: ${pack.classesCreated} task classes, ${pack.policiesCreated} policies` +
        (pack.unresolved.length
          ? `, ${pack.unresolved.length} left unconfigured (no capable model): ${pack.unresolved.join(', ')}`
          : ''),
    );
    if (pack.unresolved.length > 0) {
      out('  → those classes reject requests until an admin assigns a model (fail closed).');
    }
    out('bootstrap complete.');
  } finally {
    await close();
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('bootstrap-firm.ts') || entry.endsWith('bootstrap-firm.js')) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(1);
  }
  await bootstrapFirm(url);
}
