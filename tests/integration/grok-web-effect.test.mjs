import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectWebSocket } from './ws-client.mjs';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const ports = { runner: 18890, host: 18891, coordinator: 18892, web: 18893 };
const origin = 'http://localhost:3000';
const children = [];
function start(script, env) {
  const child = spawn(process.execPath, [path.join(root, script)], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] });
  child.stdout.on('data', () => undefined); child.stderr.on('data', (chunk) => process.stderr.write(chunk)); children.push(child); return child;
}
async function waitHealth(url) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { try { const response = await fetch(url); if (response.ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 80)); }
  throw new Error(`Health check failed: ${url}`);
}
function requestFrame(requestId, method, args) { return { protocolVersion: 1, kind: 'request', requestId, method, args }; }
async function authenticate() {
  const response = await fetch(`http://127.0.0.1:${ports.web}/v1/auth/session`, { method: 'POST', headers: { authorization: 'Bearer integration-token', origin, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200); const cookie = response.headers.getSetCookie?.()[0] || response.headers.get('set-cookie'); assert.ok(cookie); return cookie.split(';')[0];
}

test('browser refresh reconnects to same durable run without duplicate execution', { timeout: 30_000 }, async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'fabushi-web-parity-'));
  t.after(async () => { for (const child of children.splice(0)) child.kill('SIGTERM'); await rm(data, { recursive: true, force: true }); });
  const common = { NODE_ENV: 'test', FABUSHI_INTERNAL_TOKEN: 'integration-internal-token' };
  start('source/box-exec-daemon/server.mjs', { ...common, FABUSHI_RUNNER_PORT: String(ports.runner), FABUSHI_RUNNER_DATA_DIR: path.join(data, 'runner') });
  start('source/host/server.mjs', { ...common, FABUSHI_HOST_PORT: String(ports.host), FABUSHI_RUNNER_URL: `http://127.0.0.1:${ports.runner}`, FABUSHI_HOST_DATA_DIR: path.join(data, 'host'), FABUSHI_HOST_TEST_PROVIDER: 'deterministic', FABUSHI_HOST_TEST_STEP_DELAY_MS: '1200' });
  start('source/mahayana-agent-coordinator/server.mjs', { ...common, FABUSHI_COORDINATOR_PORT: String(ports.coordinator), FABUSHI_HOST_URL: `http://127.0.0.1:${ports.host}`, FABUSHI_COORDINATOR_DATA_DIR: path.join(data, 'coordinator') });
  start('source/web-main/server.mjs', { ...common, FABUSHI_WEB_MAIN_PORT: String(ports.web), FABUSHI_COORDINATOR_URL: `http://127.0.0.1:${ports.coordinator}`, FABUSHI_WEB_SESSION_SECRET: 'integration-session-secret-1234567890', FABUSHI_DEV_BEARER_TOKEN: 'integration-token', FABUSHI_ALLOWED_ORIGINS: origin });
  await Promise.all([waitHealth(`http://127.0.0.1:${ports.runner}/healthz`),waitHealth(`http://127.0.0.1:${ports.host}/healthz`),waitHealth(`http://127.0.0.1:${ports.coordinator}/healthz`),waitHealth(`http://127.0.0.1:${ports.web}/healthz`)]);
  const cookie = await authenticate();
  let ws = await connectWebSocket({ port: ports.web, cookie, origin });
  await ws.waitFor((message) => message.kind === 'lifecycle' && message.type === 'ready');
  ws.sendJson({ protocolVersion: 1, kind: 'lifecycle', type: 'hello', afterSeq: 0 });
  await ws.waitFor((message) => message.kind === 'lifecycle' && message.type === 'ready');
  const command = { type: 'chat.send', requestId: 'turn-request-1', text: 'Please use the runtime tool and tell me the current time.', agentId: 'assistant' };
  ws.sendJson(requestFrame('rpc-1', 'runtime.execute', { command }));
  const accepted = await ws.waitFor((message) => message.kind === 'reply' && message.requestId === 'rpc-1');
  assert.equal(accepted.ok, true); const operationId = accepted.result.operationId; assert.ok(operationId);
  let lastSeq = 0;
  await ws.waitFor((message) => { if (message.kind === 'event') lastSeq = Math.max(lastSeq, message.seq); return message.kind === 'event' && message.runId === operationId && message.event?.type === 'agent.step' && message.event?.kind === 'tool' && message.event?.status === 'running'; }, 8000);
  ws.close(); await new Promise((resolve) => setTimeout(resolve, 700));
  ws = await connectWebSocket({ port: ports.web, cookie, origin, afterSeq: lastSeq });
  await ws.waitFor((message) => message.kind === 'lifecycle' && message.type === 'ready');
  ws.sendJson({ protocolVersion: 1, kind: 'lifecycle', type: 'hello', afterSeq: lastSeq });
  await ws.waitFor((message) => message.kind === 'lifecycle' && message.type === 'ready');
  const seenAfterReconnect = [];
  for (;;) { const event = await ws.waitFor((message) => message.kind === 'event' && message.runId === operationId, 8000); seenAfterReconnect.push(event); lastSeq = Math.max(lastSeq, event.seq); if (event.event?.type === 'operation.completed') break; }
  assert.ok(seenAfterReconnect.some((record) => record.event?.type === 'chat.delta'));
  assert.ok(seenAfterReconnect.some((record) => record.event?.type === 'agent.step' && record.event?.kind === 'streaming'));
  ws.sendJson(requestFrame('rpc-duplicate', 'runtime.execute', { command }));
  const duplicate = await ws.waitFor((message) => message.kind === 'reply' && message.requestId === 'rpc-duplicate');
  assert.equal(duplicate.result.operationId, operationId); assert.equal(duplicate.result.deduplicated, true);
  ws.sendJson(requestFrame('rpc-resync', 'runtime.resync', { afterSeq: 0 }));
  const resync = await ws.waitFor((message) => message.kind === 'reply' && message.requestId === 'rpc-resync');
  const runEvents = resync.result.events.filter((record) => record.runId === operationId);
  assert.equal(runEvents.filter((record) => record.event.type === 'operation.started').length, 1);
  assert.equal(runEvents.filter((record) => record.event.type === 'agent.step' && record.event.kind === 'tool' && record.event.status === 'running').length, 1);
  assert.equal(runEvents.filter((record) => record.event.type === 'operation.completed').length, 1);

  const cancelCommand = { type: 'chat.send', requestId: 'turn-request-cancel', text: 'Please use the runtime tool and then answer.', agentId: 'assistant' };
  ws.sendJson(requestFrame('rpc-cancel-start', 'runtime.execute', { command: cancelCommand }));
  const cancelAccepted = await ws.waitFor((message) => message.kind === 'reply' && message.requestId === 'rpc-cancel-start');
  assert.equal(cancelAccepted.ok, true);
  const cancelledOperationId = cancelAccepted.result.operationId;
  await ws.waitFor((message) => message.kind === 'event' && message.runId === cancelledOperationId && message.event?.type === 'agent.step' && message.event?.kind === 'tool' && message.event?.status === 'running', 8000);

  ws.sendJson(requestFrame('rpc-cancel', 'runtime.interrupt', { operationId: cancelledOperationId }));
  const cancelReply = await ws.waitFor((message) => message.kind === 'reply' && message.requestId === 'rpc-cancel', 8000);
  assert.equal(cancelReply.ok, true);
  assert.equal(cancelReply.result.state, 'cancelled');
  await ws.waitFor((message) => message.kind === 'event' && message.runId === cancelledOperationId && message.event?.type === 'operation.interrupted', 8000);
  await new Promise((resolve) => setTimeout(resolve, 400));

  ws.sendJson(requestFrame('rpc-cancel-resync', 'runtime.resync', { afterSeq: 0 }));
  const cancelResync = await ws.waitFor((message) => message.kind === 'reply' && message.requestId === 'rpc-cancel-resync');
  const cancelledEvents = cancelResync.result.events.filter((record) => record.runId === cancelledOperationId);
  assert.equal(cancelledEvents.filter((record) => record.event.type === 'operation.interrupted').length, 1);
  assert.equal(cancelledEvents.filter((record) => record.event.type === 'operation.completed').length, 0);
  assert.equal(cancelledEvents.filter((record) => record.event.type === 'operation.failed').length, 0);

  ws.sendJson(requestFrame('rpc-cancel-duplicate', 'runtime.execute', { command: cancelCommand }));
  const cancelDuplicate = await ws.waitFor((message) => message.kind === 'reply' && message.requestId === 'rpc-cancel-duplicate');
  assert.equal(cancelDuplicate.result.operationId, cancelledOperationId);
  assert.equal(cancelDuplicate.result.deduplicated, true);
  ws.sendJson(requestFrame('rpc-cancel-run', 'runtime.run', { runId: cancelledOperationId }));
  const cancelledRun = await ws.waitFor((message) => message.kind === 'reply' && message.requestId === 'rpc-cancel-run');
  assert.equal(cancelledRun.result.state, 'cancelled');
  ws.close();
});
