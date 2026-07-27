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
const ADMIN_EMAIL = process.env['ADMIN_EMAIL'] ?? 'admin@demo.firm';
const ADMIN_PASSWORD = process.env['ADMIN_PASSWORD'] ?? 'vibe-router-demo-password';
const APP_TOKEN = process.env['APP_TOKEN'] ?? 'vibe-tb-demo-token';

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

  const providersRes = await fetch(`${BASE}/admin-api/providers`, { headers: { cookie } });
  const providerList = (await providersRes.json()) as { id: string; label: string }[];
  check('providers listed', providersRes.status === 200 && providerList.length > 0);
  check(
    'no credential material in listings',
    !JSON.stringify(providerList).includes('ciphertext'),
  );

  // 3 — gateway auth boundaries
  const noClass = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${APP_TOKEN}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
  });
  check('missing task-class header → 403 (fail closed)', noClass.status === 403);
  const badToken = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer not-a-token',
      'x-vibe-task-class': 'tb_classification',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
  });
  check('invalid token → 401', badToken.status === 401);
  const unknownClass = await fetch(`${BASE}/v1/chat/completions`, {
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
  const chat = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${APP_TOKEN}`,
      'x-vibe-task-class': 'tb_classification',
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

  const stream = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${APP_TOKEN}`,
      'x-vibe-task-class': 'tb_classification',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'stream check' }], stream: true }),
  });
  const streamText = await stream.text();
  check(
    'streaming completion (SSE + [DONE])',
    stream.status === 200 && streamText.includes('data:') && streamText.includes('[DONE]'),
  );

  // 5 — scrubber on local tier passes verbatim (exempt), audit + ledger evidence
  const pii = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${APP_TOKEN}`,
      'x-vibe-task-class': 'tb_classification',
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
    audit.some((a) => a.event === 'request'),
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
  const billing = await fetch(`${BASE}/v1/billing/usage?period=${period}`, {
    headers: { authorization: `Bearer ${APP_TOKEN}` },
  });
  check('billing feed answers', billing.status === 200);

  out(`\n${failures === 0 ? 'CLEAN-ROOM QA PASSED' : `CLEAN-ROOM QA FAILED (${failures} checks)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e) + '\n');
  process.exit(1);
});
