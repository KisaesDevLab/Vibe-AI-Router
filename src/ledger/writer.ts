/**
 * DB ledger (9.2/9.3): EXACTLY ONE row per request that survives auth — completed or failed.
 * Idempotency via unique request_id (insert … on conflict do nothing). Streaming usage comes
 * from the final chunk; adapter-estimated usage is flagged cost_estimated.
 */
import type { Db } from '../db/client.js';
import { usageLedger } from '../../db/schema.js';
import { pricingAt } from '../catalog/service.js';
import type { LedgerWriter, PipelineCtx } from '../gateway/pipeline.js';
import type { ErrorCode } from '../gateway/errors.js';
import { EMPTY_USAGE } from '../gateway/envelope.js';
import { computeCost } from './cost.js';
import { recordSpend } from './budget.js';

type RequestStatus = (typeof usageLedger.$inferInsert)['status'];

function statusFor(ctx: PipelineCtx): RequestStatus {
  if (!ctx.error) return 'ok';
  const map: Partial<Record<ErrorCode, RequestStatus>> = {
    policy_blocked: 'policy_blocked',
    scrubber_blocked: 'scrubber_blocked',
    budget_exceeded: 'budget_exceeded',
    rate_limited: 'rate_limited',
    capability_missing: 'capability_missing',
    provider_unavailable: 'provider_error',
    context_exceeded: 'provider_error',
    content_filtered: 'provider_error',
    invalid_request: 'error',
    auth_error: 'error',
    unknown: ctx.error.message === 'client aborted' ? 'client_abort' : 'error',
  };
  return map[ctx.error.code] ?? 'error';
}

export class DbLedger implements LedgerWriter {
  constructor(private readonly db: Db) {}

  async write(ctx: PipelineCtx): Promise<void> {
    const auth = ctx.auth;
    // pre-auth failures have no firm to attribute — logged, never ledgered (Q-033)
    if (!auth) return;

    const usage = ctx.response?.usage ?? EMPTY_USAGE;
    const model = ctx.route?.model;
    const pricing = model && ctx.response ? await pricingAt(this.db, model.id, new Date(ctx.startedAt)) : null;
    const cost = ctx.response ? computeCost(usage, pricing) : { costCents: '0', costUnknown: false };

    const inserted = await this.db
      .insert(usageLedger)
      .values({
        requestId: ctx.requestId,
        firmId: auth.firmId,
        app: auth.app,
        taskClassId: ctx.taskClass?.id ?? null,
        userId: null, // app-side user ids are external refs; ledger keeps them in client/engagement dims
        modelRequested: ctx.envelope.modelRequested ?? null,
        modelServed: ctx.response?.served.model ?? null,
        providerId: ctx.route?.provider.id ?? null,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedReadTokens: usage.cachedReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        costCents: cost.costCents,
        costUnknown: cost.costUnknown,
        costEstimated: usage.estimated,
        latencyMs: Date.now() - ctx.startedAt,
        status: statusFor(ctx),
        engagementRef: ctx.envelope.metadata.engagementRef ?? null,
        clientRef: ctx.envelope.metadata.clientRef ?? null,
        requestHash: ctx.requestHash,
      })
      .onConflictDoNothing({ target: usageLedger.requestId })
      .returning({ id: usageLedger.id });

    // budget increment only on the FIRST write for this request id (idempotency, 9.2)
    if (inserted.length > 0 && cost.costCents && Number(cost.costCents) > 0) {
      await recordSpend(this.db, {
        firmId: auth.firmId,
        app: auth.app,
        ...(ctx.envelope.metadata.userId ? { userId: ctx.envelope.metadata.userId } : {}),
        costCents: Number(cost.costCents),
      });
    }
  }
}
