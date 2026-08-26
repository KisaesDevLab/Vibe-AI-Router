/**
 * Image screening (8.6) — the identifier scrubber reads TEXT. It cannot see inside a page
 * image, so until now a `cloud_deidentified` vision class shipped its page scans to a cloud
 * model completely unexamined (the accepted caveat on `timebill_file_naming` and
 * `mybooks_receipt_extract`). This closes that hole.
 *
 * WHY SCREENING AND NOT MASKING. Masking the pixels of an SSN would need per-character
 * bounding boxes, which a chat-completions surface does not return — you would have to ask a
 * model to report coordinates and then trust them. A masking control that misses a box fails
 * OPEN: the identifier reaches the cloud provider while the ledger records "redacted". This
 * control fails CLOSED instead — an image is cleared for cloud egress only if the appliance
 * could read it AND the recognized text carried no identifier. Anything else bars the cloud
 * hop (principle 3: never fall through to allow).
 *
 * The reader is the firm's own LOCAL OCR provider, so screening never itself becomes egress:
 * the image is examined on the appliance and only then, if clean, allowed off it.
 *
 * Nothing here retains image bytes or recognized text beyond the call — the report carries
 * match TYPES and counts only, exactly like ScrubReport (invariant 2, 8.3).
 */
import type { AIRequest } from '../gateway/envelope.js';
import { scanText, type MatchType } from './scrub.js';

export interface ImageScreenReport {
  /** image parts present in the envelope */
  images: number;
  /** images whose text the appliance recovered */
  read: number;
  /** images that could not be examined — remote URL, unsupported payload, or reader failure */
  unreadable: number;
  /** identifier types + counts found across all recognized text; never the values */
  counts: Partial<Record<MatchType, number>>;
  total: number;
}

/**
 * Reads an image and returns the text it contains. Supplied by the pipeline so this module
 * stays IO-free and unit-testable. Must reject rather than hang; callers pass a signal.
 */
export type ImageReader = (dataUrl: string, signal: AbortSignal) => Promise<string>;

/** Every image part in the envelope, in message order. */
export function imageUrls(env: AIRequest): string[] {
  const out: string[] = [];
  for (const m of env.messages) {
    if (typeof m.content === 'string') continue;
    for (const p of m.content) if (p.type === 'image') out.push(p.url);
  }
  return out;
}

export function hasImages(env: AIRequest): boolean {
  for (const m of env.messages) {
    if (typeof m.content === 'string') continue;
    for (const p of m.content) if (p.type === 'image') return true;
  }
  return false;
}

/**
 * A remote URL is deliberately NOT fetched: pulling an app-supplied https URL from inside the
 * router is the SSRF surface Phase 14 exists to close, and an image the appliance never saw
 * cannot be certified clean. Such parts count as unreadable, which bars the cloud hop.
 */
function isInlineImage(url: string): boolean {
  return url.startsWith('data:');
}

/**
 * Screen every image part. Never throws on a reader failure — an unreadable image is a
 * verdict (unreadable), not an error, and the caller turns the verdict into a block.
 */
export async function screenImages(
  env: AIRequest,
  read: ImageReader,
  signal: AbortSignal,
): Promise<ImageScreenReport> {
  const urls = imageUrls(env);
  const counts: Partial<Record<MatchType, number>> = {};
  let total = 0;
  let readOk = 0;
  let unreadable = 0;

  for (const url of urls) {
    if (!isInlineImage(url)) {
      unreadable++;
      continue;
    }
    let text: string;
    try {
      text = await read(url, signal);
    } catch {
      unreadable++;
      continue;
    }
    // An empty transcription is not proof of a clean image — it is proof of nothing.
    if (text.trim().length === 0) {
      unreadable++;
      continue;
    }
    readOk++;
    for (const m of scanText(text)) {
      counts[m.type] = (counts[m.type] ?? 0) + 1;
      total++;
    }
  }

  return { images: urls.length, read: readOk, unreadable, counts, total };
}

/**
 * The egress verdict for a screened envelope.
 *   'clean'      — every image was read and none carried an identifier; cloud may proceed
 *   'identifier' — recognized text carried an identifier
 *   'unreadable' — at least one image could not be examined
 * The last two both bar cloud, but they are distinct in the audit trail because they mean
 * different things operationally: one is a document you may not send, the other is a
 * screener that is not working.
 */
export type ImageVerdict = 'clean' | 'identifier' | 'unreadable';

export function verdictOf(report: ImageScreenReport): ImageVerdict {
  if (report.total > 0) return 'identifier';
  if (report.unreadable > 0) return 'unreadable';
  return 'clean';
}
