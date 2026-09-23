import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProtocolError } from '../shared/protocol.mjs';

const COOKIE_NAME = 'fabushi_session';
function base64url(value) { return Buffer.from(value).toString('base64url'); }
function sign(secret, payload) { return createHmac('sha256', secret).update(payload).digest('base64url'); }
export function issueSession(secret, subject, ttlSeconds = 12 * 60 * 60) {
  if (!secret || secret.length < 24) throw new ProtocolError('SESSION_CONFIG', 'FABUSHI_WEB_SESSION_SECRET must be at least 24 characters');
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({ sub: subject, iat: now, exp: now + ttlSeconds }));
  return `${payload}.${sign(secret, payload)}`;
}
export function verifySession(secret, token) {
  if (!secret || !token || typeof token !== 'string') return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = sign(secret, payload);
  const a = Buffer.from(signature); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.sub !== 'string' || !data.sub || typeof data.exp !== 'number' || data.exp <= Date.now() / 1000) return null;
    return data;
  } catch { return null; }
}
export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}
export function sessionFromRequest(req, secret) { return verifySession(secret, parseCookies(req.headers.cookie)[COOKIE_NAME]); }
export function sessionCookie(token, { secure = true } = {}) { return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure ? '; Secure' : ''}`; }
