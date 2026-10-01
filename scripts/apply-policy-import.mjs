#!/usr/bin/env node
/**
 * Apply a policy export file to a running router through the admin API.
 *
 *   ROUTER_URL=https://router.example ROUTER_ADMIN_EMAIL=… ROUTER_ADMIN_PASSWORD=… \
 *     node scripts/apply-policy-import.mjs [--file docs/integration-plans/mybooks.digitalocean-policies.json] [--dry-run]
 *
 * Optional: DO_API_KEY=… creates a DigitalOcean provider (and stores the key) when the
 * firm has none. Without it the script stops and says so rather than guessing.
 *
 * What it does, in order — each step is the prerequisite of the next (see the myBooks
 * runbook §1.2 "Apply"):
 *   1. login (session cookie; nothing is printed that came from the environment)
 *   2. find the DigitalOcean provider; verify a credential is stored
 *   3. run model discovery so enrich-only ids (kimi-k3) get a catalog row
 *   4. for each task class in the file that already exists LOCAL_ONLY, widen it — import
 *      never relaxes sensitivity, but it does create absent classes with the file's tier
 *   5. POST /admin-api/policies/import
 *   6. read the policies back and print the resulting bindings
 *
 * Plain Node, no dependencies. Exits non-zero on any refused step.
 */
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileIdx = args.indexOf('--file');
const file = fileIdx >= 0 ? args[fileIdx + 1] : 'docs/integration-plans/mybooks.digitalocean-policies.json';

const base = (process.env['ROUTER_URL'] ?? '').replace(/\/+$/, '');
const email = process.env['ROUTER_ADMIN_EMAIL'];
const password = process.env['ROUTER_ADMIN_PASSWORD'];
const doApiKey = process.env['DO_API_KEY'];

if (!base || !email || !password) {
  console.error('ROUTER_URL, ROUTER_ADMIN_EMAIL and ROUTER_ADMIN_PASSWORD are required');
  process.exit(2);
}

const say = (m) => console.log(m);
let cookie = '';

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.message ?? json?.raw ?? res.statusText;
    const code = json?.error?.code ? ` [${json.error.code}]` : '';
    throw new Error(`${method} ${path} → ${res.status}${code}: ${msg}`);
  }
  return { json, res };
}

const order = { local_only: 0, cloud_deidentified: 1, cloud_allowed: 2 };

async function main() {
  const doc = JSON.parse(await readFile(file, 'utf8'));
  say(
    `file: ${file} — ${doc.taskClasses.length} classes, ${doc.policies.length} policies${dryRun ? ' (dry run)' : ''}`,
  );

  // 1. login
  const login = await call('POST', '/admin-api/auth/login', { email, password });
  const setCookie = login.res.headers.get('set-cookie') ?? '';
  cookie = setCookie.split(';')[0] ?? '';
  if (!cookie) throw new Error('login succeeded but no session cookie was returned');
  say(`logged in as ${login.json?.email ?? email} (${login.json?.role ?? 'role unknown'})`);
  const me = await call('GET', '/admin-api/auth/me');
  if (me.json?.role && me.json.role !== 'admin' && me.json.role !== 'owner') {
    say(`warning: role is '${me.json.role}'; admin endpoints may refuse`);
  }

  // 2. DigitalOcean provider + credential
  let providers = (await call('GET', '/admin-api/providers')).json ?? [];
  let doProvider = providers.find((p) => p.kind === 'digitalocean');
  if (!doProvider) {
    if (!doApiKey) {
      throw new Error(
        'no DigitalOcean provider exists for this firm. Add one in Providers → "DigitalOcean (Gradient)" ' +
          '(base URL https://inference.do-ai.run/v1) and store the model access key, or re-run with DO_API_KEY set.',
      );
    }
    if (dryRun) {
      say('would create DigitalOcean provider and store the key');
    } else {
      doProvider = (
        await call('POST', '/admin-api/providers', {
          kind: 'digitalocean',
          label: 'DigitalOcean (Gradient)',
          baseUrl: 'https://inference.do-ai.run/v1',
          authType: 'api_key',
        })
      ).json;
      await call('POST', `/admin-api/providers/${doProvider.id}/credentials`, { apiKey: doApiKey });
      say(`created provider ${doProvider.id} and stored the key`);
    }
  } else {
    const creds = doProvider.credentials ?? [];
    say(`DigitalOcean provider: ${doProvider.label} (${doProvider.id}), credentials stored: ${creds.length}`);
    if (creds.length === 0) {
      if (!doApiKey)
        throw new Error('the DigitalOcean provider has no stored credential; re-run with DO_API_KEY set');
      if (!dryRun) {
        await call('POST', `/admin-api/providers/${doProvider.id}/credentials`, { apiKey: doApiKey });
        say('stored the key');
      }
    }
  }

  // 3. discovery
  if (doProvider && !dryRun) {
    const d = (await call('POST', `/admin-api/providers/${doProvider.id}/discover-models`)).json ?? {};
    say(
      `discovery: ${d.discovered?.length ?? 0} new, ${d.alreadyKnown?.length ?? 0} already known${d.skipped?.length ? `, ${d.skipped.length} skipped` : ''}`,
    );
  } else if (doProvider) {
    say('would run model discovery');
  }

  // verify every id the file binds is in the catalog
  const models = (await call('GET', '/admin-api/models')).json ?? [];
  const known = new Set(models.map((m) => m.canonicalId));
  const wanted = new Set(
    doc.policies.flatMap((p) => [p.defaultModel, ...p.allowedModels, ...p.fallbackChain]),
  );
  const missing = [...wanted].filter((id) => !known.has(id));
  if (missing.length) {
    throw new Error(
      `not in catalog after discovery: ${missing.join(', ')}. ` +
        'If these are curated ids, the router needs a catalog sync (nightly, or a provider test/credential event) before import.',
    );
  }
  say(`catalog: all ${wanted.size} bound ids present`);

  // 4. widen existing local_only classes
  const existing = (await call('GET', '/admin-api/task-classes')).json ?? [];
  const byKey = new Map(existing.map((c) => [c.key, c]));
  for (const c of doc.taskClasses) {
    const cur = byKey.get(c.key);
    if (!cur) {
      say(`class ${c.key}: absent — import will create it ${c.sensitivity}`);
      continue;
    }
    if (order[cur.sensitivity] < order[c.sensitivity]) {
      if (dryRun) say(`class ${c.key}: ${cur.sensitivity} → would widen to ${c.sensitivity}`);
      else {
        await call('PATCH', `/admin-api/task-classes/${encodeURIComponent(c.key)}`, {
          sensitivity: c.sensitivity,
        });
        say(`class ${c.key}: widened ${cur.sensitivity} → ${c.sensitivity} (audited)`);
      }
    } else {
      say(`class ${c.key}: ${cur.sensitivity} (unchanged)`);
    }
  }

  // 5. import
  if (dryRun) {
    say('dry run — stopping before import');
    return;
  }
  const result = (await call('POST', '/admin-api/policies/import', doc)).json ?? {};
  say(`import: ${result.taskClasses ?? '?'} classes, ${result.policies ?? '?'} policies`);

  // 6. read back
  const exported = (await call('GET', '/admin-api/policies')).json ?? {};
  const keys = new Set(doc.policies.map((p) => p.taskClassKey));
  for (const p of exported.policies ?? []) {
    if (!keys.has(p.taskClassKey)) continue;
    const tc = (exported.taskClasses ?? []).find((c) => c.key === p.taskClassKey);
    say(
      `  ${p.taskClassKey.padEnd(28)} ${tc?.sensitivity ?? '?'}  default=${p.defaultModel}  fallback=[${p.fallbackChain.join(' → ')}]`,
    );
  }
  await call('POST', '/admin-api/auth/logout').catch(() => {});
}

main().catch((err) => {
  console.error(`failed: ${err.message}`);
  process.exit(1);
});
