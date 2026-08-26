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
import type { AIRequest, AIResponse } from './envelope.js';

export interface VerifyFinding {
  /** stable machine reason — safe for audit detail and error payloads */
  reason:
    | 'empty_response'
    | 'provider_error_finish'
    | 'tool_arguments_not_json'
    | 'response_not_json'
    | 'json_truncated'
    | 'schema_violation';
  message: string;
  /** JSON pointer-ish path for schema violations — a PATH only, never the offending value */
  path?: string;
}

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
 */
export function validateSchemaSubset(
  value: unknown,
  schema: unknown,
  path = '$',
): { path: string; message: string } | undefined {
  if (schema === null || typeof schema !== 'object') return undefined;
  const s = schema as JsonSchema;

  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const ok = s.enum.some((e) => e === value || JSON.stringify(e) === JSON.stringify(value));
    if (!ok) return { path, message: 'value is not one of the permitted enum members' };
  }

  const branches = s.anyOf ?? s.oneOf;
  if (Array.isArray(branches) && branches.length > 0) {
    const anyOk = branches.some((b) => validateSchemaSubset(value, b, path) === undefined);
    if (!anyOk) return { path, message: 'value matches none of the anyOf/oneOf branches' };
    return undefined;
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
    for (const key of s.required ?? []) {
      if (!(key in obj)) return { path: `${path}.${key}`, message: 'required property is missing' };
    }
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      if (key in obj) {
        const bad = validateSchemaSubset(obj[key], sub, `${path}.${key}`);
        if (bad) return bad;
      }
    }
  }

  if (Array.isArray(value) && s.items) {
    for (let i = 0; i < value.length; i++) {
      const bad = validateSchemaSubset(value[i], s.items, `${path}[${i}]`);
      if (bad) return bad;
    }
  }

  return undefined;
}

/**
 * Verify one hop's response against what the request asked for. Returns the finding that makes
 * the response unusable, or undefined when it is acceptable.
 *
 * NOTE ON INVARIANT 2: this inspects the response body in memory — as `translateResponse`
 * already does — but nothing here returns, logs, or persists content. Findings carry a reason
 * and a schema PATH only, so an audit row or client error can never leak the body.
 */
export function verifyResponse(res: AIResponse, env: AIRequest): VerifyFinding | undefined {
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
    const bad = validateSchemaSubset(parsed, env.responseFormat.schema);
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
