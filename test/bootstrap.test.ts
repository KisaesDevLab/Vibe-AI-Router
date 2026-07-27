/**
 * Production bootstrap (appliance first-run). Must be idempotent, must produce a WORKING
 * install (admin can log in, local_only classes have capable models), and must not create
 * demo data.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type DbHandle } from '../src/db/client.js';
import { migrate } from '../db/migrate.js';
import { bootstrapFirm } from '../src/ops/bootstrap-firm.js';
import { verifyPassword } from '../src/lib/password.js';
import { models, policies, taskClasses, users } from '../db/schema.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

describe.skipIf(!url)('bootstrap-firm (appliance install path)', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    const dbUrl = url as string;
    // a genuinely EMPTY database — the appliance's real first-run condition
    await migrate(dbUrl, 'down', Infinity);
    await migrate(dbUrl, 'up');
    handle = createDb(dbUrl, 2);

    process.env['FIRM_NAME'] = 'Kisaes CPA PLLC';
    process.env['ROUTER_ADMIN_EMAIL'] = 'kurt@example.test';
    process.env['ROUTER_ADMIN_PASSWORD'] = 'appliance-generated-secret-abc123';
    process.env['LOCAL_MODEL_BASE_URL'] = 'http://vibellm:11434/v1';
    process.env['LOCAL_MODEL_ID'] = 'ollama/qwen3:14b';

    return async () => handle.close();
  });

  it('creates a usable install from an empty database', async () => {
    await bootstrapFirm(url as string);

    const firm = await handle.db.query.firms.findFirst();
    expect(firm?.name).toBe('Kisaes CPA PLLC');
    expect(firm?.slug).toBe('kisaes-cpa-pllc');
    expect((firm?.settings as { scrubber_mode?: string }).scrubber_mode).toBe('redact');

    // the admin can actually log in with the appliance-generated password
    const admin = await handle.db.query.users.findFirst({ where: eq(users.email, 'kurt@example.test') });
    expect(admin?.role).toBe('admin');
    expect(await verifyPassword('appliance-generated-secret-abc123', admin!.passwordHash!)).toBe(true);

    // local provider + the served model, priced at zero (not cost_unknown)
    const provider = await handle.db.query.providers.findFirst();
    expect(provider?.kind).toBe('local');
    expect(provider?.authType).toBe('none');
    const localModel = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'ollama/qwen3:14b'),
    });
    expect(localModel?.source).toBe('custom');
    const pricing = await handle.db.query.modelPricing.findMany();
    expect(pricing.length).toBeGreaterThan(0);

    // catalog populated from the vendored feed (cloud models available to configure later)
    const allModels = await handle.db.query.models.findMany();
    expect(allModels.length).toBeGreaterThan(50);

    // policy pack applied, and EVERY local_only class resolves to a local model
    const classes = await handle.db.query.taskClasses.findMany();
    expect(classes.length).toBeGreaterThanOrEqual(14);
    const pols = await handle.db.query.policies.findMany();
    expect(pols.length).toBeGreaterThan(0);
    const byId = new Map(allModels.map((m) => [m.id, m]));
    const classById = new Map(classes.map((c) => [c.id, c]));
    for (const p of pols) {
      const cls = classById.get(p.taskClassId)!;
      if (cls.sensitivity === 'local_only') {
        expect(byId.get(p.defaultModelId)?.providerKind, `${cls.key} left the appliance`).toBe('local');
      }
    }

    // Every local policy must use the model the OPERATOR registered, never a feed entry the
    // appliance's model server doesn't serve (the catalog lists ollama models with far larger
    // context windows, including Ollama's own CLOUD-hosted ones).
    for (const p of pols) {
      const cls = classById.get(p.taskClassId)!;
      if (cls.sensitivity === 'local_only') {
        expect(byId.get(p.defaultModelId)?.canonicalId, `${cls.key} picked a model we cannot serve`).toBe(
          'ollama/qwen3:14b',
        );
      }
    }
    // …and no cloud-hosted model may be classified local, whatever its provider name says
    for (const m of allModels.filter((x) => x.providerKind === 'local')) {
      expect(m.canonicalId, 'a cloud-hosted model was imported as local').not.toMatch(/-cloud\b/);
    }

    // ZERO-CLOUD OUT OF THE BOX: with only a local provider configured, no policy may point
    // at a cloud model — even though the catalog is full of them (Phase 15B decision).
    for (const p of pols) {
      expect(byId.get(p.defaultModelId)?.providerKind, 'a policy defaulted to cloud on a local-only install').toBe(
        'local',
      );
      for (const id of [...p.allowedModelIds, ...p.fallbackChain]) {
        expect(byId.get(id)?.providerKind).toBe('local');
      }
    }

    // no demo data
    expect(await handle.db.query.users.findFirst({ where: eq(users.email, 'admin@demo.firm') })).toBeUndefined();
    const tokens = await handle.db.query.appTokens.findMany();
    expect(tokens.length).toBe(0); // tokens are minted per app in the console, never pre-created
  });

  it('is idempotent — re-running changes nothing and resets the admin password', async () => {
    const before = {
      firms: (await handle.db.query.firms.findMany()).length,
      users: (await handle.db.query.users.findMany()).length,
      providers: (await handle.db.query.providers.findMany()).length,
      classes: (await handle.db.query.taskClasses.findMany()).length,
      policies: (await handle.db.query.policies.findMany()).length,
      models: (await handle.db.query.models.findMany()).length,
    };

    process.env['ROUTER_ADMIN_PASSWORD'] = 'rotated-by-the-appliance-xyz789';
    await bootstrapFirm(url as string);

    expect({
      firms: (await handle.db.query.firms.findMany()).length,
      users: (await handle.db.query.users.findMany()).length,
      providers: (await handle.db.query.providers.findMany()).length,
      classes: (await handle.db.query.taskClasses.findMany()).length,
      policies: (await handle.db.query.policies.findMany()).length,
      models: (await handle.db.query.models.findMany()).length,
    }).toEqual(before);

    const admin = await handle.db.query.users.findFirst({ where: eq(users.email, 'kurt@example.test') });
    expect(await verifyPassword('rotated-by-the-appliance-xyz789', admin!.passwordHash!)).toBe(true);
  });

  it('refuses to run without admin credentials', async () => {
    const saved = process.env['ROUTER_ADMIN_PASSWORD'];
    delete process.env['ROUTER_ADMIN_PASSWORD'];
    await expect(bootstrapFirm(url as string)).rejects.toThrow(/required/);
    process.env['ROUTER_ADMIN_PASSWORD'] = saved;
  });

  it('leaves capability-orphaned classes unconfigured rather than mis-assigned', async () => {
    // vision-requiring classes have no capable local model by default (LOCAL_MODEL_VISION=0)
    const visionClass = await handle.db.query.taskClasses.findFirst({
      where: eq(taskClasses.key, 'v1099_w9_extract'), // local_only + vision
    });
    const policy = await handle.db.query.policies.findFirst({
      where: eq(policies.taskClassId, visionClass!.id),
    });
    // either unconfigured (fail closed) or assigned a genuinely vision-capable local model
    if (policy) {
      const model = await handle.db.query.models.findFirst({ where: eq(models.id, policy.defaultModelId) });
      const caps = { ...(model?.capabilities as object), ...(model?.capabilityOverrides as object) } as {
        vision?: boolean;
      };
      expect(caps.vision).toBe(true);
      expect(model?.providerKind).toBe('local');
    }
  });
});
