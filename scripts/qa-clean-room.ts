/**
 * Clean-room acceptance QA (Round C — also the appliance acceptance script).
 * HTTP-only: point it at any running router and it exercises the full surface.
 *
 *   ROUTER_URL=http://127.0.0.1:8226 \
 *   ADMIN_EMAIL=admin@demo.firm ADMIN_PASSWORD=… APP_TOKEN=… \
 *   pnpm tsx scripts/qa-clean-room.ts
 *
 * Exit 0 = all checks pass. Prints one line per check.
 */
const BASE = process.env['ROUTER_URL'] ?? 'http://127.0.0.1:8226';
/**
 * Where the app-facing gateway lives. On a split deployment (ROUTER_ROLE=gateway/console —
 * the appliance shape) this is a different container and URL from the console; on a combined
 * deployment (`both`) it is the same. Defaults to ROUTER_URL so single-process installs work
 * unchanged.
 */
const GATEWAY_BASE = process.env['GATEWAY_URL'] ?? BASE;
const SPLIT = GATEWAY_BASE !== BASE;
const ADMIN_EMAIL = process.env['ADMIN_EMAIL'] ?? 'admin@demo.firm';
const ADMIN_PASSWORD = process.env['ADMIN_PASSWORD'] ?? 'vibe-router-demo-password';
/**
 * App token for the gateway checks. Optional: when unset the script MINTS one through the
 * admin API, so this works against a production install (which has no demo token) as well as
 * a dev seed. Pass APP_TOKEN to exercise a specific existing token instead.
 */
let APP_TOKEN = process.env['APP_TOKEN'] ?? '';
/** Task class used for the completion checks — must be one that exists in this deployment. */
let TASK_CLASS = process.env['TASK_CLASS'] ?? '';

let failures = 0;
const out = (m: string): void => void process.stdout.write(m + '\n');
function check(name: string, ok: boolean, detail = ''): void {
  out(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  out(`clean-room QA against ${BASE}\n`);

  // 1 — liveness surface
  const healthz = await fetch(`${BASE}/healthz`);
  check('healthz 200', healthz.status === 200);
  const version = (await (await fetch(`${BASE}/version`)).json()) as { version: string };
  check('version served', typeof version.version === 'string', version.version);
  check('admin UI served', (await fetch(`${BASE}/`)).status === 200);
  const metrics = await fetch(`${BASE}/metrics`);
  check('metrics served', metrics.status === 200 && (await metrics.text()).includes('vibe_router_'));

  // 2 — admin session
  const login = await fetch(`${BASE}/admin-api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vibe-admin': '1' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  check('admin login', login.status === 200);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const me = await fetch(`${BASE}/admin-api/auth/me`, { headers: { cookie } });
  check('session /me', me.status === 200);
  check('unauthenticated admin call rejected', (await fetch(`${BASE}/admin-api/providers`)).status === 401);

  // The vendored pricing feed must actually load in THIS deployment's file layout — a
  // hard-coded relative path once resolved correctly under tsx and ENOENT'd in the container,
  // silently breaking the nightly sync while every dev-box test passed.
  const catalog = (await (
    await fetch(`${BASE}/admin-api/models`, { headers: { cookie } })
  ).json()) as { canonicalId: string; providerKind: string }[];
  check(
    'model catalog populated from the vendored feed',
    Array.isArray(catalog) && catalog.length > 50,
    `${Array.isArray(catalog) ? catalog.length : 0} models`,
  );
  check(
    'catalog includes cloud models to configure',
    Array.isArray(catalog) && catalog.some((m) => m.providerKind !== 'local'),
  );

  // Resolve the gateway fixtures from THIS deployment rather than assuming demo data.
  if (!TASK_CLASS) {
    const classes = (await (
      await fetch(`${BASE}/admin-api/task-classes`, { headers: { cookie } })
    ).json()) as { key: string; sensitivity: string }[];
    const policies = (await (
      await fetch(`${BASE}/admin-api/policies`, { headers: { cookie } })
    ).json()) as { policies: { taskClassKey: string }[] };
    const configured = new Set((policies.policies ?? []).map((p) => p.taskClassKey));
    // a local_only class WITH a policy: exercises the pipeline without needing a cloud provider
    TASK_CLASS =
      classes.find((c) => c.sensitivity === 'local_only' && configured.has(c.key))?.key ?? '';
    check('a configured local task class exists to test with', TASK_CLASS !== '', TASK_CLASS);
  }
  if (!APP_TOKEN) {
    const minted = await fetch(`${BASE}/admin-api/app-tokens`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-vibe-admin': '1' },
      body: JSON.stringify({ app: 'qa-clean-room' }),
    });
    const body = (await minted.json()) as { token?: string };
    APP_TOKEN = body.token ?? '';
    check('minted an app token through the admin API', APP_TOKEN.startsWith('vibe-qa-clean-room-'));
  }

  const providersRes = await fetch(`${BASE}/admin-api/providers`, { headers: { cookie } });
  const providerList = (await providersRes.json()) as { id: string; label: string }[];
  check('providers listed', providersRes.status === 200 && providerList.length > 0);
  check(
    'no credential material in listings',
    !JSON.stringify(providerList).includes('ciphertext'),
  );

  // 2b — SPLIT DEPLOYMENT: the published console must not carry the gateway. This is the
  // entire reason the roles were separated — if it regresses, putting the console behind TLS
  // silently republishes /v1 to whoever can reach the hostname.
  if (SPLIT) {
    for (const path of ['/v1/chat/completions', '/v1/billing/usage?period=209901']) {
      const leak = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${APP_TOKEN}`,
          'x-vibe-task-class': TASK_CLASS,
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      });
      check(`console does not serve ${path.split('?')[0]}`, leak.status === 404);
      check(
        'console 404s gateway paths as JSON (not the SPA shell)',
        (leak.headers.get('content-type') ?? '').includes('application/json'),
      );
    }
    const roles = await Promise.all(
      [BASE, GATEWAY_BASE].map(async (u) =>
        ((await (await fetch(`${u}/role`)).json()) as { role: string }).role,
      ),
    );
    check('roles are actually split', roles[0] === 'console' && roles[1] === 'gateway', roles.join(' / '));
  }

  // 3 — gateway auth boundaries
  const noClass = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${APP_TOKEN}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
  });
  check('missing task-class header → 403 (fail closed)', noClass.status === 403);
  const badToken = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer not-a-token',
      'x-vibe-task-class': TASK_CLASS,
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
  });
  check('invalid token → 401', badToken.status === 401);
  const unknownClass = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${APP_TOKEN}`,
      'x-vibe-task-class': 'zz_no_such_class',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
  });
  check('unknown task class → 403', unknownClass.status === 403);

  // 4 — completions (local tier)
  const chat = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${APP_TOKEN}`,
      'x-vibe-task-class': TASK_CLASS,
      'x-vibe-client': 'QA-CLIENT',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'clean-room completion check' }] }),
  });
  const chatBody = (await chat.json()) as { choices?: { message: { content: string } }[]; model?: string };
  const requestId = chat.headers.get('x-request-id') ?? '';
  check(
    'non-streaming completion',
    chat.status === 200 && (chatBody.choices?.[0]?.message.content.length ?? 0) > 0,
    chatBody.model,
  );
  check('x-request-id returned', requestId.length > 0);

  const stream = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${APP_TOKEN}`,
      'x-vibe-task-class': TASK_CLASS,
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'stream check' }], stream: true }),
  });
  const streamText = await stream.text();
  check(
    'streaming completion (SSE + [DONE])',
    stream.status === 200 && streamText.includes('data:') && streamText.includes('[DONE]'),
  );

  // 5 — scrubber on local tier passes verbatim (exempt), audit + ledger evidence
  const pii = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${APP_TOKEN}`,
      'x-vibe-task-class': TASK_CLASS,
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'classify SSN 123-45-6789 row' }] }),
  });
  check('local tier exempt from scrubber', pii.status === 200);

  await new Promise((r) => setTimeout(r, 300)); // fire-and-forget audit writes
  const audit = (await (
    await fetch(`${BASE}/admin-api/audit?limit=50`, { headers: { cookie } })
  ).json()) as { event: string }[];
  check(
    'audit trail records requests',
    Array.isArray(audit) && audit.some((a) => a.event === 'request'),
    `${audit.length} recent events`,
  );
  check('audit carries no prompt bodies', !JSON.stringify(audit).includes('clean-room completion check'));

  const ledgerCsv = await (
    await fetch(`${BASE}/admin-api/ledger.csv`, { headers: { cookie } })
  ).text();
  check('ledger row for the completion (by request id)', ledgerCsv.includes(requestId));
  check('ledger carries client ref dimension', ledgerCsv.includes('QA-CLIENT'));
  check('ledger carries no prompt bodies', !ledgerCsv.includes('clean-room completion check'));

  // 6 — billing feed
  const period = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  const billing = await fetch(`${GATEWAY_BASE}/v1/billing/usage?period=${period}`, {
    headers: { authorization: `Bearer ${APP_TOKEN}` },
  });
  check('billing feed answers', billing.status === 200);

  // 7 — hardening regressions (QA round D), verified black-box on the real deployment
  const nulParam = await fetch(`${BASE}/admin-api/audit?event=${encodeURIComponent('a' + String.fromCharCode(0) + 'b')}`, {
    headers: { cookie },
  });
  const nulBody = await nulParam.text();
  check('control chars in query params → 400, not 500', nulParam.status === 400);
  check(
    'server errors never leak SQL or bound parameters',
    !nulBody.includes('select ') && !nulBody.includes('params:'),
  );
  const csrf = await fetch(`${BASE}/admin-api/settings`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' }, // deliberately no x-vibe-admin
    body: JSON.stringify({ scrubber_mode: 'warn' }),
  });
  check('mutation without CSRF header rejected', csrf.status === 403);
  const forged = await fetch(`${BASE}/admin-api/providers`, { headers: { cookie: `${cookie}tampered` } });
  check('tampered session cookie rejected', forged.status === 401);

  out(`\n${failures === 0 ? 'CLEAN-ROOM QA PASSED' : `CLEAN-ROOM QA FAILED (${failures} checks)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e) + '\n');
  process.exit(1);
});
