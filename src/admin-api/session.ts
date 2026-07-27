/**
 * Admin session store (Phase 11): HMAC-signed opaque session ids in an httpOnly SameSite=Strict
 * cookie. In-memory store (single-container appliance) with sliding 12h TTL. SameSite=Strict +
 * the X-Vibe-Admin header requirement on mutations is the CSRF posture.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SessionData {
  userId: string;
  firmId: string;
  email: string;
  role: 'admin' | 'partner' | 'staff';
  expiresAt: number;
}

export const SESSION_COOKIE = 'vibe_admin_sess';
const TTL_MS = 12 * 3600_000;

export class SessionStore {
  private readonly sessions = new Map<string, SessionData>();

  constructor(private readonly secret: string) {}

  private sign(id: string): string {
    return createHmac('sha256', this.secret).update(id).digest('base64url');
  }

  create(data: Omit<SessionData, 'expiresAt'>): string {
    const id = randomBytes(24).toString('base64url');
    this.sessions.set(id, { ...data, expiresAt: Date.now() + TTL_MS });
    return `${id}.${this.sign(id)}`;
  }

  get(cookieValue: string | undefined): SessionData | undefined {
    if (!cookieValue) return undefined;
    const dot = cookieValue.lastIndexOf('.');
    if (dot === -1) return undefined;
    const id = cookieValue.slice(0, dot);
    const sig = cookieValue.slice(dot + 1);
    const expected = this.sign(id);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    session.expiresAt = Date.now() + TTL_MS; // sliding
    return session;
  }

  destroy(cookieValue: string | undefined): void {
    if (!cookieValue) return;
    const id = cookieValue.slice(0, cookieValue.lastIndexOf('.'));
    this.sessions.delete(id);
  }
}

export function parseCookies(req: FastifyRequest): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function setSessionCookie(reply: FastifyReply, value: string, secure: boolean): void {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${TTL_MS / 1000}`,
    ...(secure ? ['Secure'] : []),
  ];
  void reply.header('set-cookie', attrs.join('; '));
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}
