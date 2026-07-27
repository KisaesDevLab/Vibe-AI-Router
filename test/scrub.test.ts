/**
 * Scrubber corpus (8.1): true positives, lookalike negatives, redaction, envelope walk,
 * and the 100KB perf budget (8.9). Corpus documented in docs/scrubber.md.
 */
import { describe, expect, it } from 'vitest';
import { redactEnvelope, redactText, scanEnvelope, scanText } from '../src/protect/scrub.js';
import type { AIRequest } from '../src/gateway/envelope.js';

const types = (text: string): string[] => scanText(text).map((m) => m.type);

describe('SSN detection', () => {
  it('matches valid dashed/spaced SSNs', () => {
    expect(types('SSN 123-45-6789 on file')).toEqual(['ssn']);
    expect(types('ssn: 123 45 6789')).toEqual(['ssn']);
  });
  it('rejects invalid areas/groups/serials', () => {
    expect(types('000-45-6789')).toEqual([]); // area 000
    expect(types('666-45-6789')).toEqual([]); // area 666
    expect(types('900-45-6789')).toEqual([]); // area 9xx
    expect(types('123-00-6789')).toEqual([]); // group 00
    expect(types('123-45-0000')).toEqual([]); // serial 0000
  });
  it('bare 9 digits only with an SSN keyword nearby', () => {
    expect(types('social security number 123456789')).toEqual(['ssn']);
    expect(types('order id 123456789 shipped')).toEqual([]); // no keyword → not SSN
  });
  it('lookalike negatives: dates, ZIP+4, phone-shaped strings', () => {
    expect(types('meeting on 2026-07-26 at noon')).toEqual([]);
    expect(types('Kansas City MO 64106-2145')).toEqual([]); // ZIP+4 is 5-4, not 3-2-4
    expect(types('call 555-0142')).toEqual([]);
  });
});

describe('EIN detection', () => {
  it('matches valid campus prefixes, rejects invalid ones', () => {
    expect(types('EIN 12-3456789')).toEqual(['ein']);
    expect(types('EIN 07-3456789')).toEqual([]); // 07 not a valid prefix
    expect(types('EIN 89-3456789')).toEqual([]); // 89 not a valid prefix
  });
  it('does not fire inside longer digit runs', () => {
    expect(types('serial 912-3456789-99')).toEqual([]);
  });
});

describe('routing + account detection', () => {
  // 021000021 (JPMorgan) and 011401533 pass the ABA checksum
  it('matches checksum-valid routing numbers', () => {
    expect(types('routing 021000021')).toEqual(['routing']);
    expect(types('ABA 011401533')).toEqual(['routing']);
  });
  it('rejects checksum failures and invalid prefixes', () => {
    expect(types('number 021000022')).toEqual([]); // bad checksum
    expect(types('number 421000021')).toEqual([]); // prefix 42 invalid even if checksum ok? (checksum also fails) — deterministic reject
  });
  it('account numbers fire only near routing numbers or account keywords', () => {
    expect(types('routing 021000021 account 000123456789')).toEqual(['routing', 'account']);
    expect(types('acct no. 000123456789')).toEqual(['account']);
    expect(types('the year 20260726 was mentioned and 000123456789 later')).toEqual([]); // no keyword, no routing nearby
  });
  it('invoice-number negative: long digits without context do not match', () => {
    expect(types('invoice 4111111111 total $88')).toEqual([]); // 10 digits, no Luhn-13+, no context
  });
});

describe('credit card detection (Luhn + IIN)', () => {
  it('matches valid cards incl. separated forms', () => {
    expect(types('visa 4111111111111111')).toEqual(['card']);
    expect(types('card 4111 1111 1111 1111 exp 12/27')).toEqual(['card']);
    expect(types('amex 378282246310005')).toEqual(['card']);
    expect(types('mc 5555555555554444')).toEqual(['card']);
  });
  it('rejects Luhn failures and non-IIN 16-digit runs', () => {
    expect(types('4111111111111112')).toEqual([]); // Luhn fail
    expect(types('9999999999999995')).toEqual([]); // no IIN — even if Luhn-ok shapes exist
  });
});

describe('redaction (8.4)', () => {
  it('replaces spans with type tokens', () => {
    const text = 'SSN 123-45-6789, card 4111111111111111, routing 021000021';
    const out = redactText(text, scanText(text));
    expect(out).toBe('SSN [SSN], card [CARD], routing [ROUTING]');
  });

  it('redactEnvelope deep-copies: original untouched, copy scrubbed, tool args included', () => {
    const env: AIRequest = {
      taskClass: 'k',
      messages: [
        { role: 'user', content: 'my ssn is 123-45-6789' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'save', arguments: '{"ssn":"123-45-6789"}' }],
        },
        { role: 'tool', toolCallId: 'c1', content: 'stored for 123-45-6789' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'card 4111111111111111' },
            { type: 'image', url: 'data:image/png;base64,AA' },
          ],
        },
      ],
      stream: false,
      metadata: { app: 'vibe-tb' },
    };
    const { envelope: red, report } = redactEnvelope(env);
    expect(report.counts).toEqual({ ssn: 3, card: 1 });
    // original object untouched
    expect(env.messages[0]?.content).toContain('123-45-6789');
    // copy scrubbed everywhere, including tool arguments and tool results
    expect(JSON.stringify(red)).not.toContain('123-45-6789');
    expect(JSON.stringify(red)).not.toContain('4111111111111111');
    expect((red.messages[1]?.toolCalls?.[0]?.arguments ?? '')).toContain('[SSN]');
    expect(red.messages[3]?.content?.[1]).toEqual({ type: 'image', url: 'data:image/png;base64,AA' });
  });

  it('scanEnvelope reports counts only — no values anywhere in the report', () => {
    const env: AIRequest = {
      taskClass: 'k',
      messages: [{ role: 'user', content: 'EIN 12-3456789 and EIN 13-9876543' }],
      stream: false,
      metadata: { app: 'x' },
    };
    const report = scanEnvelope(env);
    expect(report).toEqual({ counts: { ein: 2 }, total: 2 });
    expect(JSON.stringify(report)).not.toContain('3456789');
  });
});

describe('perf budget (8.9): 100KB in < 5ms', () => {
  it('median of 7 runs under budget', () => {
    // realistic-ish workpaper prose with scattered numerics
    const para =
      'The taxpayer operates a Schedule C consulting business. Gross receipts of 184,220 were ' +
      'reported for the year ended 2025-12-31. Invoice 20250098 remains outstanding. Depreciation ' +
      'per Form 4562 totals 12,840 with a Section 179 election of 8,000. Contact 555-0142. ';
    let text = '';
    while (text.length < 100_000) text += para;
    text += ' SSN 123-45-6789 routing 021000021 acct 000998877 card 4111 1111 1111 1111 ';

    const durations: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      scanText(text);
      durations.push(performance.now() - t0);
    }
    durations.sort((a, b) => a - b);
    const median = durations[3]!;
    expect(median).toBeLessThan(5);
  });
});
