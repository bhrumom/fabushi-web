import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, ProtocolError, RUN_STATES, makeRun, validateClientEnvelope, validateRuntimeCommand } from '../../source/shared/protocol.mjs';

test('protocol accepts typed request/reply lifecycle contract', () => {
  const request = validateClientEnvelope({ protocolVersion: PROTOCOL_VERSION, kind: 'request', requestId: 'req-1', method: 'runtime.execute', args: { command: { type: 'conversation.list', requestId: 'cmd-1' } } });
  assert.equal(request.method, 'runtime.execute');
});
test('protocol rejects incompatible versions', () => {
  assert.throws(() => validateClientEnvelope({ protocolVersion: 99, kind: 'lifecycle', type: 'hello' }), (error) => { assert.equal(error instanceof ProtocolError, true); assert.equal(error.code, 'PROTOCOL_MISMATCH'); return true; });
});
test('chat commands require durable caller request ids and non-empty text', () => {
  assert.throws(() => validateRuntimeCommand({ type: 'chat.send', requestId: 'x', text: '   ' }), /command.text/);
  assert.equal(validateRuntimeCommand({ type: 'chat.send', requestId: 'x', text: 'hello' }).text, 'hello');
});
test('run states include Grok Web lifecycle states', () => {
  for (const state of ['accepted','preparing','thinking','tool-running','streaming','completed','recovering']) assert.ok(RUN_STATES.includes(state), `missing ${state}`);
  const run = makeRun({ requestId: 'r', ownerId: 'u', conversationId: 'c', agentId: 'a', text: 'hello' });
  assert.equal(run.state, 'accepted'); assert.match(run.executionKey, /^run:/);
});
