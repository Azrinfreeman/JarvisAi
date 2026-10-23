import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { UserError } from '../errors.js';

const random = () => randomBytes(32).toString('hex');
export function equalSecret(left: unknown, right: string) {
  return typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
export class OwnerSessions {
  private cookieName = `rainbot_${randomBytes(8).toString('hex')}`;
  private code = random();
  private issued = Date.now();
  private sessions = new Map<string, { csrf: string; expires: number }>();
  private attempts = 0;
  private window = Date.now();
  accessCode() { return this.code; }
  exchange(input: unknown) {
    if (Date.now() - this.window > 60000) { this.attempts = 0; this.window = Date.now(); }
    if (++this.attempts > 12) throw new UserError('Too many connection attempts. Wait a minute.');
    if (!this.code || Date.now() - this.issued > 10 * 60000 || !equalSecret(input, this.code)) throw new UserError('The local access code is invalid or expired. Restart the dashboard for a new code.');
    this.code = '';
    const id = random(); const csrf = random();
    this.sessions.set(id, { csrf, expires: Date.now() + 12 * 3600000 });
    return { csrf, cookie: `${this.cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` };
  }
  get(req: IncomingMessage) {
    const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(this.cookieName+'='))?.slice(this.cookieName.length+1);
    const session = cookie ? this.sessions.get(cookie) : undefined;
    if (session && session.expires > Date.now()) return session;
    if (cookie) this.sessions.delete(cookie);
  }
  require(req: IncomingMessage, mutation = false) {
    const session = this.get(req);
    if (!session) throw new UserError('Connect this browser using the local access code from the dashboard terminal.');
    if (mutation && !equalSecret(req.headers['x-csrf-token'], session.csrf)) throw new UserError('The workspace session changed. Reload and try again.');
    return session;
  }
}
