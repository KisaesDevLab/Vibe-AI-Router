import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '../src/lib/logger.js';

function capture(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines: () => chunks };
}

describe('logger redaction (invariant: prompt bodies never in logs)', () => {
  it('redacts message arrays and completion choices at every configured path', () => {
    const { stream, lines } = capture();
    const log = createLogger('info', false, stream);

    log.info({
      req: { body: { messages: [{ role: 'user', content: 'SSN 123-45-6789 secret prompt' }] } },
      res: { body: { choices: [{ message: { content: 'secret completion' } }] } },
      body: { content: [{ type: 'text', text: 'anthropic secret' }] },
    });

    const out = lines().join('');
    expect(out).not.toContain('secret prompt');
    expect(out).not.toContain('secret completion');
    expect(out).not.toContain('anthropic secret');
    expect(out).not.toContain('123-45-6789');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts credential material', () => {
    const { stream, lines } = capture();
    const log = createLogger('info', false, stream);

    log.info({
      provider: { apiKey: 'sk-live-abc123' },
      req: { headers: { authorization: 'Bearer tok-xyz' } },
    });

    const out = lines().join('');
    expect(out).not.toContain('sk-live-abc123');
    expect(out).not.toContain('tok-xyz');
  });
});
