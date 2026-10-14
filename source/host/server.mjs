import http from 'node:http';
import { HostRuntime } from './host-service.mjs';
import { HostProductService } from './product-service.mjs';
import { errorEnvelope } from '../shared/protocol.mjs';

const host = process.env.FABUSHI_HOST_BIND || '127.0.0.1';
const port = Number(process.env.FABUSHI_HOST_PORT || 8789);
const internalToken = process.env.FABUSHI_INTERNAL_TOKEN || '';
const runtime = new HostRuntime();
const products = new HostProductService();

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
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'fabushi-host' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/product') {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid internal token' } }));
        return;
      }
      const input = await readJson(req);
      const ownerId = String(input.ownerId || '').trim();
      if (!ownerId) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'OWNER_REQUIRED', message: 'ownerId is required' } }));
        return;
      }
      const result = input.command
        ? { events: await products.runtimeCommand(ownerId, input.command) }
        : { result: await products.invoke(ownerId, String(input.method || ''), input.args || {}) };
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ...result }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/turn/cancel') {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid internal token' } }));
        return;
      }
      const input = await readJson(req);
      const result = await runtime.cancelTurn(input);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/turn') {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid internal token' } }));
        return;
      }
      const input = await readJson(req);
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      await runtime.runTurn(input, async (event) => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`); });
      if (!res.destroyed) res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  } catch (error) {
    if (!res.headersSent) res.writeHead(error?.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { 'content-type': 'application/json' });
    if (!res.destroyed) res.end(JSON.stringify({ error: errorEnvelope(error) }));
  }
});
server.listen(port, host, () => console.log(JSON.stringify({ service: 'fabushi-host', host, port })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
