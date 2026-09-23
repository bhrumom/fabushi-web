import http from 'node:http';
import { MahayanaCoordinatorService } from './coordinator.mjs';
import { errorEnvelope } from '../shared/protocol.mjs';

const host = process.env.FABUSHI_COORDINATOR_HOST || '127.0.0.1';
const port = Number(process.env.FABUSHI_COORDINATOR_PORT || 8788);
const internalToken = process.env.FABUSHI_INTERNAL_TOKEN || '';
const coordinator = new MahayanaCoordinatorService();
await coordinator.initialize();

async function readJson(req, maxBytes = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body too large'), { code: 'PAYLOAD_TOO_LARGE' });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function authorized(req) {
  if (!internalToken) return process.env.NODE_ENV !== 'production';
  return req.headers.authorization === `Bearer ${internalToken}`;
}
function ownerFrom(req) {
  const owner = req.headers['x-fabushi-owner'];
  return Array.isArray(owner) ? owner[0] : owner;
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'mahayana-agent-coordinator' }));
      return;
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid internal token' } }));
      return;
    }
    const ownerId = ownerFrom(req);
    if (typeof ownerId !== 'string' || !ownerId.trim()) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'OWNER_REQUIRED', message: 'x-fabushi-owner is required' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/request') {
      const body = await readJson(req);
      const result = await coordinator.request(ownerId, body.method, body.args || {});
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/v1/events')) {
      const url = new URL(req.url, 'http://coordinator.local');
      const result = await coordinator.pollEvents(ownerId, Number(url.searchParams.get('afterSeq') || 0), Number(url.searchParams.get('timeoutMs') || 20_000));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  } catch (error) {
    res.writeHead(error?.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: errorEnvelope(error) }));
  }
});
server.listen(port, host, () => console.log(JSON.stringify({ service: 'mahayana-agent-coordinator', host, port })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
