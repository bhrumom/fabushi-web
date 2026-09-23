import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { acceptUpgrade } from './raw-websocket.mjs';
import { issueSession, sessionCookie, sessionFromRequest } from './session.mjs';
import { PROTOCOL_VERSION, ProtocolError, errorEnvelope, makeFailureReply, makeLifecycle, makeReply, validateClientEnvelope } from '../shared/protocol.mjs';

const bindHost = process.env.FABUSHI_WEB_MAIN_HOST || '0.0.0.0';
const port = Number(process.env.FABUSHI_WEB_MAIN_PORT || 8787);
const coordinatorUrl = (process.env.FABUSHI_COORDINATOR_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
const internalToken = process.env.FABUSHI_INTERNAL_TOKEN || '';
const sessionSecret = process.env.FABUSHI_WEB_SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'development-session-secret-change-me');
const devBearer = process.env.FABUSHI_DEV_BEARER_TOKEN || '';
const allowedOrigins = new Set((process.env.FABUSHI_ALLOWED_ORIGINS || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000,http://127.0.0.1:3000')).split(',').map((value) => value.trim()).filter(Boolean));

function originAllowed(origin) { return origin ? allowedOrigins.has(origin) : process.env.NODE_ENV !== 'production'; }
function internalHeaders(ownerId) { return { 'content-type': 'application/json', 'x-fabushi-owner': ownerId, ...(internalToken ? { authorization: `Bearer ${internalToken}` } : {}) }; }
async function coordinatorRequest(ownerId, method, args = {}) {
  const response = await fetch(`${coordinatorUrl}/v1/request`, { method: 'POST', headers: internalHeaders(ownerId), body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) { const error = body?.error || {}; throw new ProtocolError(error.code || 'COORDINATOR_FAILED', error.message || `Coordinator HTTP ${response.status}`, error.details); }
  return body.result;
}
async function pollCoordinator(ownerId, afterSeq) {
  const url = new URL('/v1/events', coordinatorUrl); url.searchParams.set('afterSeq', String(afterSeq)); url.searchParams.set('timeoutMs', '20000');
  const response = await fetch(url, { headers: internalHeaders(ownerId), signal: AbortSignal.timeout(25_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) throw new ProtocolError('COORDINATOR_FAILED', body?.error?.message || `Coordinator HTTP ${response.status}`);
  return body.result;
}
async function readJson(req, maxBytes = 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new ProtocolError('PAYLOAD_TOO_LARGE', 'Request body too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
async function exchangeAccessToken(req) {
  const authorization = req.headers.authorization || ''; const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!bearer) throw new ProtocolError('UNAUTHORIZED', 'Bearer token is required');
  if (devBearer && bearer === devBearer && process.env.NODE_ENV !== 'production') return { sub: 'test-user' };
  const introspectionUrl = process.env.FABUSHI_AUTH_INTROSPECTION_URL;
  if (!introspectionUrl) throw new ProtocolError('AUTH_NOT_CONFIGURED', 'FABUSHI_AUTH_INTROSPECTION_URL is required for production session exchange');
  const response = await fetch(introspectionUrl, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.active === false || typeof body.sub !== 'string' || !body.sub) throw new ProtocolError('UNAUTHORIZED', 'Access token introspection failed');
  return { sub: body.sub };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, service: 'fabushi-web-main', protocolVersion: PROTOCOL_VERSION })); return; }
    if (req.method === 'POST' && req.url === '/v1/auth/session') {
      if (!originAllowed(req.headers.origin)) throw new ProtocolError('ORIGIN_DENIED', 'Origin is not allowed');
      await readJson(req).catch(() => ({})); const identity = await exchangeAccessToken(req); const token = issueSession(sessionSecret, identity.sub);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': sessionCookie(token, { secure: process.env.NODE_ENV === 'production' }) });
      res.end(JSON.stringify({ ok: true, user: { id: identity.sub } })); return;
    }
    if (req.method === 'GET' && req.url === '/v1/auth/status') {
      const session = sessionFromRequest(req, sessionSecret); res.writeHead(session ? 200 : 401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ loggedIn: Boolean(session), ...(session ? { user: { id: session.sub } } : {}) })); return;
    }
    if (req.method === 'POST' && req.url === '/v1/auth/logout') {
      if (!originAllowed(req.headers.origin)) throw new ProtocolError('ORIGIN_DENIED', 'Origin is not allowed');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': 'fabushi_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (process.env.NODE_ENV === 'production' ? '; Secure' : '') }); res.end(JSON.stringify({ ok: true })); return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  } catch (error) {
    const failure = errorEnvelope(error); const status = failure.code === 'UNAUTHORIZED' ? 401 : failure.code === 'ORIGIN_DENIED' ? 403 : 400;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: failure }));
  }
});

server.on('upgrade', (req, socket, head) => { void (async () => {
  try {
    const url = new URL(req.url || '/', 'http://web-main.local');
    if (url.pathname !== '/v1/coordinator') throw new ProtocolError('NOT_FOUND', 'Unknown WebSocket endpoint');
    if (!originAllowed(req.headers.origin)) throw new ProtocolError('ORIGIN_DENIED', 'Origin is not allowed');
    const session = sessionFromRequest(req, sessionSecret); if (!session) throw new ProtocolError('UNAUTHORIZED', 'Authenticated session cookie is required');
    const ws = acceptUpgrade(req, socket, head); const connectionId = randomUUID(); let afterSeq = Number(url.searchParams.get('afterSeq') || 0);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) afterSeq = 0;
    let helloReceived = false, stopped = false, pumping = false; ws.onClose(() => { stopped = true; });
    ws.sendJson(makeLifecycle('ready', { connectionId, sessionId: session.sub, highWaterMark: afterSeq }));
    ws.onMessage(async (text) => {
      let envelope;
      try { envelope = validateClientEnvelope(JSON.parse(text)); } catch (error) { ws.sendJson(makeFailureReply('invalid', error)); return; }
      if (envelope.kind === 'lifecycle') {
        if (envelope.type === 'shutdown') { ws.close(1000, 'client shutdown'); return; }
        helloReceived = true; const requestedSeq = Number(envelope.afterSeq || 0); if (Number.isSafeInteger(requestedSeq) && requestedSeq >= 0) afterSeq = requestedSeq;
        const resync = await coordinatorRequest(session.sub, 'runtime.resync', { afterSeq });
        ws.sendJson(makeLifecycle('ready', { connectionId, sessionId: session.sub, highWaterMark: resync.highWaterMark, activeRuns: resync.activeRuns })); return;
      }
      try {
        let result;
        if (envelope.method === 'auth.status') result = { loggedIn: true, provider: 'web-session', user: { id: session.sub } };
        else if (envelope.method === 'auth.providers') result = [];
        else if (envelope.method.startsWith('runtime.')) result = await coordinatorRequest(session.sub, envelope.method, envelope.args || {});
        else if (envelope.method.startsWith('marketplace.') || envelope.method.startsWith('plugin.')) {
          result = await coordinatorRequest(session.sub, 'product.request', { method: envelope.method, args: envelope.args || {} });
        } else throw new ProtocolError('METHOD_NOT_FOUND', `Web Main method is not implemented: ${envelope.method}`);
        ws.sendJson(makeReply(envelope.requestId, result));
      } catch (error) { ws.sendJson(makeFailureReply(envelope.requestId, error)); }
    });
    const heartbeat = setInterval(() => { if (stopped || ws.closed) return; if (Date.now() - ws.lastPongAt > 60_000) { ws.close(1001, 'heartbeat timeout'); return; } ws.ping(String(Date.now())); }, 20_000);
    const pump = async () => {
      if (pumping || stopped) return; pumping = true;
      try { while (!stopped && !ws.closed) { const batch = await pollCoordinator(session.sub, afterSeq); for (const record of batch.events || []) { if (record.seq <= afterSeq) continue; ws.sendJson({ protocolVersion: PROTOCOL_VERSION, kind: 'event', seq: record.seq, runId: record.runId, conversationId: record.conversationId, timestamp: record.timestamp, event: record.event }); afterSeq = record.seq; } } }
      catch (error) { if (!stopped) ws.close(1011, error instanceof Error ? error.message : 'event pump failed'); }
      finally { pumping = false; clearInterval(heartbeat); }
    };
    void pump();
    const helloDeadline = setTimeout(() => { if (!helloReceived && !stopped) ws.close(1008, 'hello required'); }, 10_000); ws.onClose(() => clearTimeout(helloDeadline));
  } catch (error) {
    const failure = errorEnvelope(error); const status = failure.code === 'UNAUTHORIZED' ? '401 Unauthorized' : failure.code === 'ORIGIN_DENIED' ? '403 Forbidden' : '400 Bad Request';
    try { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ error: failure })}`); } catch { socket.destroy(); }
  }
})() });
server.listen(port, bindHost, () => console.log(JSON.stringify({ service: 'fabushi-web-main', host: bindHost, port })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
