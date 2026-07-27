/**
 * Shadow validation harness (12.5): every fixture prompt runs through BOTH paths —
 *   direct : straight to the model endpoint (the app's pre-migration behavior)
 *   router : through the Vibe AI Router via @kisaes/vibe-ai-client
 * — then outputs SHADOW-DIFF-REPORT.md (match rate + divergence samples as SHA-256 hashes,
 * never bodies).
 *
 *   SHADOW_DIRECT_URL=http://localhost:11434/v1  SHADOW_DIRECT_MODEL=qwen3:14b \
 *   SHADOW_ROUTER_URL=http://localhost:8220      SHADOW_ROUTER_TOKEN=…         \
 *   pnpm tsx scripts/shadow-diff.ts
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VibeAiClient } from '../packages/sdk/src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = (m: string): void => void process.stdout.write(m + '\n');

interface Fixtures {
  taskClass: string;
  system: string;
  temperature: number;
  cases: { id: string; input: string }[];
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** normalize structured outputs so whitespace/key-order noise doesn't count as divergence */
function normalize(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify(parsed, Object.keys(parsed).sort());
  } catch {
    return text.trim();
  }
}

async function directCall(fx: Fixtures, input: string): Promise<string> {
  const res = await fetch(`${process.env['SHADOW_DIRECT_URL'] ?? 'http://localhost:11434/v1'}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env['SHADOW_DIRECT_KEY'] ? { authorization: `Bearer ${process.env['SHADOW_DIRECT_KEY']}` } : {}),
    },
    body: JSON.stringify({
      model: process.env['SHADOW_DIRECT_MODEL'] ?? 'qwen3:14b',
      messages: [
        { role: 'system', content: fx.system },
        { role: 'user', content: input },
      ],
      temperature: fx.temperature,
      max_tokens: 512,
    }),
  });
  if (!res.ok) throw new Error(`direct path HTTP ${res.status}`);
  const body = (await res.json()) as { choices: { message: { content: string | null } }[] };
  return body.choices[0]?.message.content ?? '';
}

async function main(): Promise<void> {
  const fx = JSON.parse(await readFile(join(ROOT, 'data/shadow-fixtures.json'), 'utf8')) as Fixtures;
  const router = new VibeAiClient({
    baseUrl: process.env['SHADOW_ROUTER_URL'] ?? 'http://localhost:8220',
    token: process.env['SHADOW_ROUTER_TOKEN'] ?? 'vibe-tb-demo-token',
  });

  const rows: { id: string; match: boolean; directHash: string; routerHash: string; model: string }[] = [];
  for (const c of fx.cases) {
    const [direct, viaRouter] = await Promise.all([
      directCall(fx, c.input),
      router.complete(
        fx.taskClass,
        [
          { role: 'system', content: fx.system },
          { role: 'user', content: c.input },
        ],
        { temperature: fx.temperature, maxTokens: 512 },
      ),
    ]);
    const d = normalize(direct);
    const r = normalize(viaRouter.content);
    rows.push({
      id: c.id,
      match: d === r,
      directHash: sha(d),
      routerHash: sha(r),
      model: viaRouter.model,
    });
    out(`${c.id}: ${d === r ? 'MATCH' : 'DIVERGE'}`);
  }

  const matches = rows.filter((r) => r.match).length;
  const rate = ((matches / rows.length) * 100).toFixed(1);
  const report = [
    '# Shadow-diff report (12.5)',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Task class: \`${fx.taskClass}\` · temperature ${fx.temperature}`,
    `- Direct: \`${process.env['SHADOW_DIRECT_URL'] ?? 'http://localhost:11434/v1'}\` (${process.env['SHADOW_DIRECT_MODEL'] ?? 'qwen3:14b'})`,
    `- Router: \`${process.env['SHADOW_ROUTER_URL'] ?? 'http://localhost:8220'}\` → served by \`${rows[0]?.model ?? '?'}\``,
    `- **Match rate: ${matches}/${rows.length} (${rate}%)** on normalized output`,
    '',
    '| case | result | direct sha256/16 | router sha256/16 |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.id} | ${r.match ? '✓ match' : '✗ diverge'} | \`${r.directHash}\` | \`${r.routerHash}\` |`),
    '',
    'Divergence samples are identified by hash only — output bodies are never written to disk.',
  ].join('\n');
  await writeFile(join(ROOT, 'SHADOW-DIFF-REPORT.md'), report + '\n');
  out(`\nmatch rate ${rate}% → SHADOW-DIFF-REPORT.md`);
  if (matches !== rows.length) process.exitCode = 2;
}

main().catch((e: unknown) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e) + '\n');
  process.exit(1);
});
