/**
 * Image screening (8.6): the control that lets a `cloud_deidentified` vision class mean
 * something for page images, not just message text. Every case here is a fail-closed check —
 * the ones that MUST bar cloud egress matter more than the one that must allow it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  hasImages,
  imageUrls,
  screenImages,
  verdictOf,
  type ImageReader,
} from '../src/protect/image-screen.js';
import type { AIRequest } from '../src/gateway/envelope.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAA=';

type Part = { type: 'text'; text: string } | { type: 'image'; url: string };

function env(...parts: Part[]): AIRequest {
  return {
    taskClass: 'timebill_file_naming',
    messages: [{ role: 'user', content: parts }],
    stream: false,
    metadata: { app: 'vibe-time-billing' },
  };
}

const reader = (text: string): ImageReader => () => Promise.resolve(text);
const signal = new AbortController().signal;

describe('envelope image discovery', () => {
  it('finds image parts across messages, in order', () => {
    const e: AIRequest = {
      taskClass: 't',
      stream: false,
      metadata: { app: 'a' },
      messages: [
        { role: 'system', content: 'plain string content has no parts' },
        { role: 'user', content: [{ type: 'image', url: PNG }, { type: 'text', text: 'hi' }] },
        { role: 'user', content: [{ type: 'image', url: PNG2 }] },
      ],
    };
    expect(imageUrls(e)).toEqual([PNG, PNG2]);
    expect(hasImages(e)).toBe(true);
  });

  it('reports no images for a text-only envelope', () => {
    const e = env({ type: 'text', text: 'no pictures here' });
    expect(hasImages(e)).toBe(false);
    expect(imageUrls(e)).toEqual([]);
  });
});

describe('screening verdicts', () => {
  it('clears a page whose recognized text carries no identifier', async () => {
    const r = await screenImages(env({ type: 'image', url: PNG }), reader('Form 1040 tax year 2025'), signal);
    expect(r).toMatchObject({ images: 1, read: 1, unreadable: 0, total: 0 });
    expect(verdictOf(r)).toBe('clean');
  });

  it('catches an SSN that only exists inside the image', async () => {
    const r = await screenImages(
      env({ type: 'image', url: PNG }),
      reader('Taxpayer SSN 123-45-6789'),
      signal,
    );
    expect(r.counts.ssn).toBe(1);
    expect(verdictOf(r)).toBe('identifier');
  });

  it('catches an EIN inside the image', async () => {
    const r = await screenImages(env({ type: 'image', url: PNG }), reader('EIN 12-3456789'), signal);
    expect(r.total).toBeGreaterThan(0);
    expect(verdictOf(r)).toBe('identifier');
  });

  it('screens every image, not just the first', async () => {
    const texts = ['clean cover page', 'SSN 123-45-6789'];
    let i = 0;
    const r = await screenImages(
      env({ type: 'image', url: PNG }, { type: 'image', url: PNG2 }),
      () => Promise.resolve(texts[i++]!),
      signal,
    );
    expect(r.images).toBe(2);
    expect(r.read).toBe(2);
    expect(verdictOf(r)).toBe('identifier');
  });
});

describe('fail-closed properties', () => {
  it('never fetches a remote URL, and treats it as uncertified', async () => {
    const read = vi.fn<ImageReader>(() => Promise.resolve('anything'));
    const r = await screenImages(env({ type: 'image', url: 'https://example.com/page.png' }), read, signal);
    expect(read).not.toHaveBeenCalled(); // SSRF: the router does not go and get it
    expect(r).toMatchObject({ images: 1, read: 0, unreadable: 1 });
    expect(verdictOf(r)).toBe('unreadable');
  });

  it('treats a reader failure as uncertified rather than clean', async () => {
    const r = await screenImages(
      env({ type: 'image', url: PNG }),
      () => Promise.reject(new Error('ocr server down')),
      signal,
    );
    expect(verdictOf(r)).toBe('unreadable');
  });

  it('treats an empty transcription as uncertified — silence is not proof', async () => {
    const r = await screenImages(env({ type: 'image', url: PNG }), reader('   \n  '), signal);
    expect(r.read).toBe(0);
    expect(r.unreadable).toBe(1);
    expect(verdictOf(r)).toBe('unreadable');
  });

  it('an identifier outranks an unreadable sibling — the stronger reason wins', async () => {
    const texts = ['SSN 123-45-6789', ''];
    let i = 0;
    const r = await screenImages(
      env({ type: 'image', url: PNG }, { type: 'image', url: PNG2 }),
      () => Promise.resolve(texts[i++]!),
      signal,
    );
    expect(r.unreadable).toBe(1);
    expect(verdictOf(r)).toBe('identifier');
  });

  it('reports types and counts only — never the recognized text', async () => {
    const r = await screenImages(
      env({ type: 'image', url: PNG }),
      reader('SSN 123-45-6789 for Jane Doe at 42 Elm St'),
      signal,
    );
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain('123-45-6789');
    expect(serialized).not.toContain('Jane Doe');
    expect(Object.keys(r.counts)).toEqual(['ssn']);
  });
});
