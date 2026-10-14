import http from 'node:http';
import { SafeRunner } from './runtime.mjs';
import { errorEnvelope } from '../shared/protocol.mjs';

const host = process.env.FABUSHI_RUNNER_HOST || '127.0.0.1';
const port = Number(process.env.FABUSHI_RUNNER_PORT || 8790);
const internalToken = process.env.FABUSHI_INTERNAL_TOKEN || '';
const runner = new SafeRunner();

async function readJson(req, maxBytes = 512 * 1024) {
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
      res.end(JSON.stringify({ ok: true, service: 'fabushi-box-exec-daemon' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/tools/execute') {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid internal token' } }));
        return;
      }
      const result = await runner.execute(await readJson(req));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  } catch (error) {
    res.writeHead(error?.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: errorEnvelope(error) }));
  }
});

server.listen(port, host, () => console.log(JSON.stringify({ service: 'fabushi-box-exec-daemon', host, port })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
