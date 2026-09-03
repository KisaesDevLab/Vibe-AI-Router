/**
 * Response verification (Phase 10 extension): a provider that answers **200 with an unusable
 * result** is a failure, not a success.
 *
 * Adapters already reject STRUCTURALLY malformed responses at the wire edge (`translateResponse`
 * throws on a body that fails the OpenAI/Anthropic shape). What they cannot judge is whether a
 * well-formed envelope actually carries the answer the caller asked for: an empty completion, a
 * forced-JSON request answered with prose, tool-call arguments that are not JSON, a schema the
 * response does not satisfy. Those reach the app as a 200 today, the breaker records a success,
 * and the provider stays green — so nothing retries and no fallback hop is ever considered.
 *
 * This module is the missing verdict. The resilience executor calls it after every hop and turns
 * a finding into a RETRYABLE `invalid_response`, which buys three layers of redundancy for free:
 * same-model retry (LLM output is stochastic — a re-roll often succeeds), then the policy's
 * fallback chain, then the breaker if a provider does it persistently.
 *
 * Scope is deliberately narrow: it verifies only what the REQUEST asked for. A plain text
 * completion is checked for emptiness and nothing else — the router does not grade answers.
 */
import type { AIRequest, AIResponse, SchemaValidationMode } from './envelope.js';
export type { SchemaValidationMode } from './envelope.js';

/**
 * The `detail.reason` vocabulary of `invalid_response`. Exported as a runtime array so the audit
 * registry and the SDK's mirror (`INVALID_RESPONSE_REASONS` in `@kisaes/vibe-ai-client`) can be
 * asserted equal in tests — they drifted silently once (Vibe 1040, 2026-09-03).
 */
export const INVALID_RESPONSE_REASONS = [
  'empty_response',
  'provider_error_finish',
  'tool_arguments_not_json',
  'response_not_json',
  'json_truncated',
  'schema_violation',
] as const;
export type InvalidResponseReason = (typeof INVALID_RESPONSE_REASONS)[number];

export interface VerifyFinding {
  /** stable machine reason — safe for audit detail and error payloads */
  reason: InvalidResponseReason;
  message: string;
  /** JSON pointer-ish path for schema violations — a PATH only, never the offending value */
  path?: string;
}

/**
 * A schema deviation that does NOT make the response unusable (structural validation, item C of
 * the Vibe 1040 follow-ups). Today the only soft keyword is `enum`: a model inventing one value
 * outside a 40-member enum is a data-quality event for the app to handle, not a reason to burn a
 * retry and a fallback walk. Carries a PATH only — never the offending value (invariant 2).
 */
export interface SoftFinding {
  keyword: 'enum';
  path: string;
}

export const SOFT_FINDING_REASONS = ['schema_enum_miss'] as const;
export type SoftFindingReason = (typeof SOFT_FINDING_REASONS)[number];

/** Models fence forced-JSON output surprisingly often; the SDK strips the same way. */
export function stripFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  nullable?: boolean;
};

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === 'integer') return actual === 'number' && Number.isInteger(value);
  if (expected === 'number') return actual === 'number';
  return actual === expected;
}

/**
 * JSON Schema **subset** validator — deliberately dependency-free.
 *
 * Supports the constructs the suite's task classes actually emit: `type` (including a union
 * array and `nullable`), `properties`, `required`, `items`, `enum`, `anyOf`/`oneOf`. Everything
 * else (`$ref`, `allOf`, `patternProperties`, numeric/string bounds, `additionalProperties`) is
 * IGNORED — unrecognized keywords never fail a response. That asymmetry is intentional: this is
 * a fault detector, so a construct it cannot evaluate must not manufacture a false failure. It
 * catches the failure that actually happens in practice — a model returning the wrong SHAPE —
 * and is not a substitute for validating untrusted input.
 *
 * Returns the first violation, or undefined when the value satisfies the supported subset.
 *
 * `opts.soft`, when supplied, switches `enum` to STRUCTURAL mode: a miss is appended there as a
 * SoftFinding and evaluation continues. Without it (strict mode) an enum miss is a hard violation
 * exactly as before. `required`/`type`/`items` are always hard — those break parsing.
 */
export function validateSchemaSubset(
  value: unknown,
  schema: unknown,
  path = '$',
  opts?: {
    soft?: SoftFinding[];
    /** internal: number of enum constraints the value SATISFIED (anyOf discriminator logic) */
    hits?: { count: number };
  },
): { path: string; message: string } | undefined {
  if (schema === null || typeof schema !== 'object') return undefined;
  const s = schema as JsonSchema;

  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const ok = s.enum.some((e) => e === value || JSON.stringify(e) === JSON.stringify(value));
    if (!ok) {
      if (!opts?.soft) return { path, message: 'value is not one of the permitted enum members' };
      opts.soft.push({ keyword: 'enum', path });
    } else if (opts?.hits) {
      opts.hits.count++;
    }
  }

  const branches = s.anyOf ?? s.oneOf;
  if (Array.isArray(branches) && branches.length > 0) {
    // Pass 1 — every branch STRICT (enum hard). In a discriminated union the enum IS the
    // discriminator; evaluating branches softly would let a variant with looser `required`
    // absorb an object missing another variant's required fields, and would stamp a spurious
    // soft finding on every valid value that merely matched a later branch. A clean strict
    // match wins outright and contributes no soft findings.
    for (const b of branches) {
      if (validateSchemaSubset(value, b, path) === undefined) return undefined;
    }
    // Pass 2 — only if no branch matched strictly and we are in structural mode. Each branch
    // gets a scratch collector. A branch whose enum(s) the value SATISFIED (≥1 hit, 0 misses)
    // and which then failed structurally is AUTHORITATIVE: the value identified itself as that
    // variant, so its missing `required` field is a hard violation — a looser sibling branch
    // must not absorb it via a soft enum miss. Otherwise the first branch that passes on
    // structure alone wins and contributes its enum misses (and only its own) as soft findings.
    if (opts?.soft) {
      let softWinner: { soft: SoftFinding[]; hits: number } | undefined;
      for (const b of branches) {
        const scratch: SoftFinding[] = [];
        const hits = { count: 0 };
        const bad = validateSchemaSubset(value, b, path, { soft: scratch, hits });
        if (bad === undefined) {
          softWinner ??= { soft: scratch, hits: hits.count };
          continue;
        }
        if (hits.count > 0 && scratch.length === 0) return bad;
      }
      if (softWinner) {
        opts.soft.push(...softWinner.soft);
        if (opts.hits) opts.hits.count += softWinner.hits;
        return undefined;
      }
    }
    return { path, message: 'value matches none of the anyOf/oneOf branches' };
  }

  if (s.type !== undefined) {
    const expected = Array.isArray(s.type) ? s.type : [s.type];
    const permitted = s.nullable === true ? [...expected, 'null'] : expected;
    if (!permitted.some((t) => typeMatches(value, t))) {
      return { path, message: `expected ${permitted.join(' | ')}, received ${typeOf(value)}` };
    }
  }

  if (typeOf(value) === 'object' && (s.properties || s.required)) {
    const obj = value as Record<string, unknown>;
    // present properties FIRST so a discriminator enum registers as a hit before a missing
    // sibling `required` field returns — the anyOf logic above depends on that ordering
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      if (key in obj) {
        const bad = validateSchemaSubset(obj[key], sub, `${path}.${key}`, opts);
        if (bad) return bad;
      }
    }
    for (const key of s.required ?? []) {
      if (!(key in obj)) return { path: `${path}.${key}`, message: 'required property is missing' };
    }
  }

  if (Array.isArray(value) && s.items) {
    for (let i = 0; i < value.length; i++) {
      const bad = validateSchemaSubset(value[i], s.items, `${path}[${i}]`, opts);
      if (bad) return bad;
    }
  }

  return undefined;
}

/**
 * Verify one hop's response against what the request asked for. Returns the finding that makes
 * the response unusable, or undefined when it is acceptable.
 *
 * `soft` collects structural-mode deviations (enum misses) for the caller to audit and count;
 * the response still passes. It is ignored when the request asked for
 * `responseFormat.validation: 'strict'`, where an enum miss is a hard finding.
 *
 * NOTE ON INVARIANT 2: this inspects the response body in memory — as `translateResponse`
 * already does — but nothing here returns, logs, or persists content. Findings carry a reason
 * and a schema PATH only, so an audit row or client error can never leak the body.
 */
/**
 * Which validation mode applies to a forced-JSON request (Q-099):
 *  1. an explicit router-extension `validation` on the request wins;
 *  2. otherwise OpenAI's `strict: true` is honoured as a hint — a client that asked the
 *     provider for strict schema adherence has said what it wants, and it may be an older SDK
 *     or a plain `openai` client that cannot send the router key;
 *  3. otherwise the deployment default (`ROUTER_SCHEMA_VALIDATION`, structural unless set).
 */
export function resolveValidationMode(
  rf: AIRequest['responseFormat'],
  defaultMode: SchemaValidationMode = 'structural',
): SchemaValidationMode {
  if (rf?.type !== 'json_schema') return defaultMode;
  if (rf.validation) return rf.validation;
  if (rf.strict === true) return 'strict';
  return defaultMode;
}

export function verifyResponse(
  res: AIResponse,
  env: AIRequest,
  soft?: SoftFinding[],
  defaultMode: SchemaValidationMode = 'structural',
): VerifyFinding | undefined {
  const content = res.message.content ?? '';
  const toolCalls = res.message.toolCalls ?? [];
  const wantsJson = env.responseFormat?.type === 'json_schema' || env.responseFormat?.type === 'json_object';

  // A provider that signals its own failure in finish_reason (e.g. DeepSeek's
  // insufficient_system_resource) is a fault even when the envelope parses.
  if (res.finishReason === 'error') {
    return { reason: 'provider_error_finish', message: 'provider reported an error finish reason' };
  }

  // Emptiness. `content_filter` is EXEMPT: a refusal is a legitimate terminal outcome that
  // retrying and falling back would only repeat (and would burn a second provider's tokens).
  if (content.trim() === '' && toolCalls.length === 0 && res.finishReason !== 'content_filter') {
    return { reason: 'empty_response', message: 'provider returned no content and no tool calls' };
  }

  // Tool-call arguments are transported as an opaque string; nothing upstream checks them.
  for (const tc of toolCalls) {
    try {
      JSON.parse(tc.arguments);
    } catch {
      return {
        reason: 'tool_arguments_not_json',
        message: `tool call ${tc.name} produced arguments that are not valid JSON`,
      };
    }
  }

  if (!wantsJson) return undefined;

  // Some providers answer a forced-JSON request with a tool call instead of content — the SDK
  // already tolerates that shape, so verification must too.
  const source = content.trim() !== '' ? content : (toolCalls[0]?.arguments ?? '');

  // Truncation is checked BEFORE parsing: a max_tokens cutoff usually breaks the JSON, and
  // reporting "not valid JSON" for it sends the operator chasing the wrong fault.
  if (res.finishReason === 'length') {
    return { reason: 'json_truncated', message: 'forced-JSON response was truncated at max_tokens' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(source));
  } catch {
    return { reason: 'response_not_json', message: 'forced-JSON response did not parse as JSON' };
  }

  if (env.responseFormat?.type === 'json_schema' && env.responseFormat.schema) {
    // structural: enum misses are soft; strict: hard. Resolution order in resolveValidationMode.
    const strict = resolveValidationMode(env.responseFormat, defaultMode) === 'strict';
    const bad = validateSchemaSubset(
      parsed,
      env.responseFormat.schema,
      '$',
      strict ? undefined : { soft: soft ?? [] },
    );
    if (bad) {
      return {
        reason: 'schema_violation',
        message: `response does not satisfy ${env.responseFormat.name}: ${bad.message}`,
        path: bad.path,
      };
    }
  }

  return undefined;
}
