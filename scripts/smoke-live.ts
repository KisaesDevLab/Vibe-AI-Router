/**
 * Optional live smoke (3.9/3.10) — NOT run in CI. Points the openai-compat adapter at a real
 * endpoint (default: local Ollama) and runs one non-streaming + one streaming completion.
 *
 *   SMOKE_BASE_URL=http://localhost:11434/v1 SMOKE_MODEL=ollama/qwen3:14b pnpm tsx scripts/smoke-live.ts
 *   SMOKE_BASE_URL=https://api.openai.com/v1 SMOKE_MODEL=openai/gpt-4o-mini SMOKE_API_KEY=sk-… pnpm tsx scripts/smoke-live.ts
 */
import { OpenAiCompatAdapter } from '../src/adapters/openai-compat/index.js';
import type { ExecuteContext } from '../src/gateway/adapter-types.js';
import type { AIRequest } from '../src/gateway/envelope.js';

const out = (m: string): void => void process.stdout.write(m + '\n');

async function main(): Promise<void> {
  const baseUrl = process.env['SMOKE_BASE_URL'] ?? 'http://localhost:11434/v1';
  const model = process.env['SMOKE_MODEL'] ?? 'ollama/qwen3:14b';
  const apiKey = process.env['SMOKE_API_KEY'];

  const adapter = new OpenAiCompatAdapter();
  const ctx: ExecuteContext = {
    providerId: 'smoke',
    model,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
  };
  const env: AIRequest = {
    taskClass: 'smoke',
    messages: [{ role: 'user', content: 'Reply with exactly: SMOKE OK' }],
    maxTokens: 50,
    stream: false,
    metadata: { app: 'smoke' },
  };

  out(`→ testConnection ${baseUrl}`);
  const test = await adapter.testConnection(ctx, AbortSignal.timeout(15000));
  out(`  ok=${test.ok} latency=${test.latencyMs}ms ${JSON.stringify(test.probedCapabilities ?? {})}`);
  if (!test.ok) {
    out(`  errorCode=${test.errorCode ?? 'unknown'} — aborting smoke`);
    process.exit(1);
  }

  out(`→ non-streaming completion (${model})`);
  const res = await adapter.execute(env, ctx, AbortSignal.timeout(120000));
  out(`  [${res.finishReason}] ${res.message.content.slice(0, 120)}`);
  out(
    `  usage p=${res.usage.promptTokens} c=${res.usage.completionTokens} estimated=${res.usage.estimated}`,
  );

  out('→ streaming completion');
  let text = '';
  let usage = '';
  for await (const chunk of adapter.executeStream({ ...env, stream: true }, ctx, AbortSignal.timeout(120000))) {
    if (chunk.type === 'text_delta') text += chunk.delta;
    if (chunk.type === 'finish' && chunk.usage)
      usage = `p=${chunk.usage.promptTokens} c=${chunk.usage.completionTokens} estimated=${chunk.usage.estimated}`;
  }
  out(`  ${text.slice(0, 120)}`);
  out(`  usage ${usage}`);
  out('SMOKE PASSED');
  process.exit(0);
}

main().catch((e: unknown) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e) + '\n');
  process.exit(1);
});
