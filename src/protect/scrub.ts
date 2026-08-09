/**
 * Deterministic PII scrubber (8.1) — pure functions, no ML, no network. Detects:
 *   SSN (area-number validation), EIN (IRS campus prefix table), US bank routing numbers
 *   (ABA checksum + Federal-Reserve prefix ranges), account numbers (co-occurrence
 *   heuristic), credit cards (Luhn + IIN prefixes).
 * Matched VALUES never leave this module's scrub result except inside the redacted copy;
 * blocking surfaces match TYPES + counts only (8.3).
 */
import type { AIMessage, AIRequest } from '../gateway/envelope.js';

/** the identifier classes the scrubber detects — single source of truth (WISP export cites it) */
export const MATCH_TYPES = ['ssn', 'ein', 'routing', 'account', 'card'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

export interface ScrubMatch {
  type: MatchType;
  start: number;
  end: number;
}

// ── SSN ──────────────────────────────────────────────────────────────────────

function validSsnParts(area: string, group: string, serial: string): boolean {
  const a = Number(area);
  if (a === 0 || a === 666 || a >= 900) return false;
  if (Number(group) === 0) return false;
  if (Number(serial) === 0) return false;
  return true;
}

// ── EIN: valid IRS campus/electronic prefixes ────────────────────────────────

const EIN_PREFIXES = new Set(
  [
    '01','02','03','04','05','06','10','11','12','13','14','15','16','20','21','22','23','24',
    '25','26','27','30','31','32','33','34','35','36','37','38','39','40','41','42','43','44',
    '45','46','47','48','50','51','52','53','54','55','56','57','58','59','60','61','62','63',
    '64','65','66','67','68','71','72','73','74','75','76','77','80','81','82','83','84','85',
    '86','87','88','90','91','92','93','94','95','98','99',
  ],
);

// ── ABA routing ──────────────────────────────────────────────────────────────

function abaChecksumValid(digits: string): boolean {
  if (digits.length !== 9) return false;
  const d = digits.split('').map(Number);
  const sum =
    3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + 1 * (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0 && sum > 0;
}

function abaPrefixValid(digits: string): boolean {
  const p = Number(digits.slice(0, 2));
  return (p >= 0 && p <= 12) || (p >= 21 && p <= 32) || (p >= 61 && p <= 72) || p === 80;
}

// ── credit card: Luhn + IIN ──────────────────────────────────────────────────

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function iinValid(digits: string): boolean {
  if (/^4\d{12}(\d{3})?(\d{3})?$/.test(digits)) return true; // Visa 13/16/19
  if (/^5[1-5]\d{14}$/.test(digits)) return true; // Mastercard
  const first4 = Number(digits.slice(0, 4));
  if (digits.length === 16 && first4 >= 2221 && first4 <= 2720) return true; // MC 2-series
  if (/^3[47]\d{13}$/.test(digits)) return true; // Amex
  if (/^(6011|65\d{2}|64[4-9]\d)\d{12}$/.test(digits)) return true; // Discover
  return false;
}

// ── scanning ─────────────────────────────────────────────────────────────────

const ACCOUNT_KEYWORD = /acc(?:oun)?t(?:\s*(?:#|no\.?|num(?:ber)?))?|iban|checking|savings/i;
const SSN_KEYWORD = /ssn|social\s*security|taxpayer\s*id|itin/i;

function overlaps(matches: ScrubMatch[], start: number, end: number): boolean {
  return matches.some((m) => start < m.end && end > m.start);
}

/** Scan one text for all match types. Deterministic, order-independent output (sorted). */
export function scanText(text: string): ScrubMatch[] {
  const matches: ScrubMatch[] = [];

  // 1) cards first (longest digit runs) — Luhn + IIN over 13-19 digits with separators
  for (const m of text.matchAll(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g)) {
    const raw = m[0];
    const digits = raw.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (luhnValid(digits) && iinValid(digits)) {
      matches.push({ type: 'card', start: m.index, end: m.index + raw.length });
    }
  }

  // 2) routing: 9 consecutive digits, checksum + prefix
  const routingSpans: [number, number][] = [];
  for (const m of text.matchAll(/(?<![\d-])\d{9}(?![\d-])/g)) {
    if (overlaps(matches, m.index, m.index + 9)) continue;
    if (abaChecksumValid(m[0]) && abaPrefixValid(m[0])) {
      matches.push({ type: 'routing', start: m.index, end: m.index + 9 });
      routingSpans.push([m.index, m.index + 9]);
    }
  }

  // 3) SSN dashed/spaced (validated), plus bare 9-digit with an SSN keyword nearby
  for (const m of text.matchAll(/(?<![\d-])(\d{3})([- ])(\d{2})\2(\d{4})(?![\d-])/g)) {
    if (overlaps(matches, m.index, m.index + m[0].length)) continue;
    if (validSsnParts(m[1]!, m[3]!, m[4]!)) {
      matches.push({ type: 'ssn', start: m.index, end: m.index + m[0].length });
    }
  }
  for (const m of text.matchAll(/(?<![\d-])\d{9}(?![\d-])/g)) {
    if (overlaps(matches, m.index, m.index + 9)) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (SSN_KEYWORD.test(before) && validSsnParts(m[0].slice(0, 3), m[0].slice(3, 5), m[0].slice(5))) {
      matches.push({ type: 'ssn', start: m.index, end: m.index + 9 });
    }
  }

  // 4) EIN: NN-NNNNNNN with valid prefix
  for (const m of text.matchAll(/(?<![\d-])(\d{2})-(\d{7})(?![\d-])/g)) {
    if (overlaps(matches, m.index, m.index + m[0].length)) continue;
    if (EIN_PREFIXES.has(m[1]!)) {
      matches.push({ type: 'ein', start: m.index, end: m.index + m[0].length });
    }
  }

  // 5) account numbers: 6-17 digit runs co-occurring with a routing match (±120 chars) or an
  //    account keyword within the preceding 30 chars (8.1 heuristic)
  for (const m of text.matchAll(/(?<![\d-])\d{6,17}(?![\d-])/g)) {
    if (overlaps(matches, m.index, m.index + m[0].length)) continue;
    const nearRouting = routingSpans.some(
      ([s, e]) => Math.abs(m.index - e) <= 120 || Math.abs(s - (m.index + m[0].length)) <= 120,
    );
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    if (nearRouting || ACCOUNT_KEYWORD.test(before)) {
      matches.push({ type: 'account', start: m.index, end: m.index + m[0].length });
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

const REDACTION: Record<MatchType, string> = {
  ssn: '[SSN]',
  ein: '[EIN]',
  routing: '[ROUTING]',
  account: '[ACCOUNT]',
  card: '[CARD]',
};

export function redactText(text: string, matches: ScrubMatch[]): string {
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue; // overlapping (already consumed)
    out += text.slice(cursor, m.start) + REDACTION[m.type];
    cursor = m.end;
  }
  return out + text.slice(cursor);
}

// ── envelope-level scrub (8.2/8.4) ───────────────────────────────────────────

export interface ScrubReport {
  /** counts per type — the ONLY thing that may leave the scrubber on block/warn */
  counts: Partial<Record<MatchType, number>>;
  total: number;
}

function* textFields(env: AIRequest): Generator<string> {
  for (const m of env.messages) {
    if (typeof m.content === 'string') yield m.content;
    else for (const p of m.content) if (p.type === 'text') yield p.text;
    for (const tc of m.toolCalls ?? []) yield tc.arguments;
  }
}

export function scanEnvelope(env: AIRequest): ScrubReport {
  const counts: Partial<Record<MatchType, number>> = {};
  let total = 0;
  for (const text of textFields(env)) {
    for (const m of scanText(text)) {
      counts[m.type] = (counts[m.type] ?? 0) + 1;
      total++;
    }
  }
  return { counts, total };
}

/**
 * One-way redaction (8.4): returns a DEEP COPY with matched spans replaced; the input
 * envelope object is never mutated. There is no de-tokenization anywhere in the codebase.
 */
export function redactEnvelope(env: AIRequest): { envelope: AIRequest; report: ScrubReport } {
  const counts: Partial<Record<MatchType, number>> = {};
  let total = 0;
  const scrubString = (text: string): string => {
    const matches = scanText(text);
    for (const m of matches) {
      counts[m.type] = (counts[m.type] ?? 0) + 1;
      total++;
    }
    return matches.length > 0 ? redactText(text, matches) : text;
  };

  const messages: AIMessage[] = env.messages.map((m) => ({
    ...m,
    content:
      typeof m.content === 'string'
        ? scrubString(m.content)
        : m.content.map((p) => (p.type === 'text' ? { ...p, text: scrubString(p.text) } : { ...p })),
    ...(m.toolCalls
      ? { toolCalls: m.toolCalls.map((tc) => ({ ...tc, arguments: scrubString(tc.arguments) })) }
      : {}),
  }));

  return { envelope: { ...env, messages }, report: { counts, total } };
}
