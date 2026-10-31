import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { MomentError } from './moment-context.mjs';

// This capability only permits bounded, stateless AI requests. It never authenticates
// /v1 accounts or private media. Restarting the process expires it; local drafts survive.
export function createMomentGuest({ secret = randomBytes(32), now = Date.now, ttlMs = 86400000 } = {}) {
  const name = 'unseen_moment_guest';
  const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
  function read(req) {
    const token = String(req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith(name + '='))?.slice(name.length + 1);
    if (!token || token.length > 200) return null;
    const [id, expiry, signature, extra] = token.split('.');
    if (extra || !/^[a-f0-9-]{36}$/.test(id || '') || !/^\d{13}$/.test(expiry || '') || !/^[\w-]{43}$/.test(signature || '')) return null;
    const expiresAt = Number(expiry), expected = sign(`${id}.${expiry}`);
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) || expiresAt <= now() || expiresAt > now() + ttlMs) return null;
    return { id, token, expiresAt };
  }
  return {
    issue(req) {
      const current = read(req), id = current?.id || randomUUID(), expiresAt = current?.expiresAt || now() + ttlMs;
      const value = `${id}.${expiresAt}`, token = current?.token || `${value}.${sign(value)}`;
      const secure = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
      return `${name}=${token}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor((expiresAt - now()) / 1000))}${secure ? '; Secure' : ''}`;
    },
    authenticate(req) {
      const session = read(req);
      if (!session) throw new MomentError('guest_session_expired', 401);
      if (req.headers['x-unseen-expected-account-id']) throw new MomentError('account_changed', 409);
      return { accountId: `guest:${session.id}` };
    }
  };
}
