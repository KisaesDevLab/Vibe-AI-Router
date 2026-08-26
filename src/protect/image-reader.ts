/**
 * The appliance-local image reader behind image screening (8.6).
 *
 * Screening must never itself be egress, so the reader is pinned to the LOCAL tier: it will
 * drive a `local_ocr` provider (the shared GLM-OCR llama-server, Q-075) or a vision-capable
 * `local` model, and nothing else. If the firm has neither, there is no reader — and a
 * cloud-bound request carrying images is barred rather than sent unexamined.
 *
 * This deliberately does NOT go through routeForModel: that resolves the model the REQUEST is
 * routed to, which for a cloud-bound vision call is the very model we are screening for.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { isLocalKind, models } from '../../db/schema.js';
import { effectiveCapabilities } from '../catalog/service.js';
import type { ExecuteContext } from '../gateway/adapter-types.js';
import type { AIRequest } from '../gateway/envelope.js';
import type { AdapterRegistry } from '../gateway/pipeline.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { ImageReader } from './image-screen.js';

/** Kept blunt on purpose: we want characters, not an interpretation of the document. */
const TRANSCRIBE_PROMPT =
  'Transcribe every character of text visible in this image, verbatim, including all digits ' +
  'and punctuation, preserving the order they appear in. Do not summarise, describe, or omit ' +
  'anything. Output the transcription only.';

/** Generous: a truncated transcription is an unscreened tail of the page. */
const TRANSCRIBE_MAX_TOKENS = 4096;

export interface ImageReaderDeps {
  db: Db;
  engine: PolicyEngine;
  adapters: AdapterRegistry;
  getApiKey?: (providerId: string) => Promise<string | undefined>;
}

type ModelRow = typeof models.$inferSelect;

/**
 * Pick the model that reads the page. `local_ocr` first — that is a purpose-built OCR server
 * and the reason the kind exists — then any vision-capable `local` model. Operator-registered
 * rows (`source: 'custom'`, i.e. "the model my server actually serves") beat synced catalog
 * entries, matching pickDefaultModel.
 */
export async function pickScreenerModel(db: Db, firmId: string, engine: PolicyEngine): Promise<ModelRow | null> {
  const candidates = await db.query.models.findMany({ where: eq(models.status, 'active') });
  const usable = candidates.filter(
    (m) => isLocalKind(m.providerKind) && effectiveCapabilities(m).vision,
  );
  if (usable.length === 0) return null;

  const rank = (m: ModelRow): number => {
    const kindScore = m.providerKind === 'local_ocr' ? 0 : 1;
    const sourceScore = m.source === 'custom' ? 0 : 1;
    return kindScore * 2 + sourceScore;
  };
  const ordered = [...usable].sort((a, b) => rank(a) - rank(b) || b.contextWindow - a.contextWindow);

  // Only offer a model whose provider the firm has actually configured.
  for (const m of ordered) {
    const provider = await engine.providerFor(firmId, m.providerKind);
    if (provider) return m;
  }
  return null;
}

/**
 * Build the reader, or null when the appliance has no local eyes. Null is a meaningful
 * result, not a failure: the caller turns it into a cloud block.
 */
export async function buildImageReader(
  deps: ImageReaderDeps,
  firmId: string,
): Promise<{ read: ImageReader; model: ModelRow } | null> {
  const model = await pickScreenerModel(deps.db, firmId, deps.engine);
  if (!model) return null;

  const provider = await deps.engine.providerFor(firmId, model.providerKind);
  if (!provider) return null;
  const adapter = deps.adapters.forKind(provider.kind);
  if (!adapter) return null;

  let apiKey: string | undefined;
  if (provider.authType === 'api_key') {
    apiKey = deps.getApiKey ? await deps.getApiKey(provider.id) : undefined;
    if (!apiKey) return null;
  }

  const executeCtx: ExecuteContext = {
    providerId: provider.id,
    model: model.canonicalId,
    baseUrl: provider.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(provider.modelMapping && typeof provider.modelMapping === 'object'
      ? { modelMapping: provider.modelMapping as Record<string, string> }
      : {}),
  };

  const read: ImageReader = async (dataUrl, signal) => {
    const env: AIRequest = {
      // The screener is infrastructure, not app traffic: it names no app task class and
      // writes no ledger row of its own (its tokens are appliance-local by construction).
      taskClass: '__image_screen__',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', url: dataUrl },
            { type: 'text', text: TRANSCRIBE_PROMPT },
          ],
        },
      ],
      maxTokens: TRANSCRIBE_MAX_TOKENS,
      temperature: 0,
      stream: false,
      metadata: { app: 'vibe-ai-router' },
    };
    const res = await adapter.execute(env, executeCtx, signal);
    return res.message.content;
  };

  return { read, model };
}
