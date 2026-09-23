import { randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const RUN_STATES = Object.freeze([
  'accepted',
  'queued',
  'preparing',
  'thinking',
  'tool-running',
  'streaming',
  'waiting-user',
  'completed',
  'failed',
  'cancelled',
  'recovering',
]);
export const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled']);

export function nowIso() {
  return new Date().toISOString();
}

export function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function requireString(value, name, { min = 1, max = 16384 } = {}) {
  if (typeof value !== 'string') throw new ProtocolError('INVALID_ARGUMENT', `${name} must be a string`);
  const text = value.trim();
  if (text.length < min || text.length > max) {
    throw new ProtocolError('INVALID_ARGUMENT', `${name} length must be between ${min} and ${max}`);
  }
  return text;
}

export class ProtocolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.details = details;
  }
}

export function errorEnvelope(error) {
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL';
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return { code, message, ...(error?.details !== undefined ? { details: error.details } : {}) };
}

export function makeReply(requestId, result) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'reply',
    requestId,
    ok: true,
    result,
  };
}

export function makeFailureReply(requestId, error) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'reply',
    requestId,
    ok: false,
    error: errorEnvelope(error),
  };
}

export function makeLifecycle(type, fields = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'lifecycle',
    type,
    timestamp: nowIso(),
    ...fields,
  };
}

export function validateClientEnvelope(value) {
  const envelope = asRecord(value);
  if (!envelope) throw new ProtocolError('BAD_FRAME', 'WebSocket payload must be a JSON object');
  if (envelope.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError('PROTOCOL_MISMATCH', `Protocol ${String(envelope.protocolVersion)} is not supported`, {
      supported: [PROTOCOL_VERSION],
    });
  }
  if (envelope.kind === 'lifecycle') {
    if (envelope.type !== 'hello' && envelope.type !== 'shutdown') {
      throw new ProtocolError('BAD_FRAME', 'Unknown lifecycle frame');
    }
    return envelope;
  }
  if (envelope.kind !== 'request') throw new ProtocolError('BAD_FRAME', 'Expected request or lifecycle frame');
  requireString(envelope.requestId, 'requestId', { max: 128 });
  requireString(envelope.method, 'method', { max: 160 });
  if (envelope.args !== undefined && !asRecord(envelope.args)) {
    throw new ProtocolError('INVALID_ARGUMENT', 'request args must be an object');
  }
  return envelope;
}

export function validateRuntimeCommand(value) {
  const command = asRecord(value);
  if (!command) throw new ProtocolError('INVALID_COMMAND', 'Runtime command must be an object');
  requireString(command.type, 'command.type', { max: 96 });
  requireString(command.requestId, 'command.requestId', { max: 128 });
  if (command.type === 'chat.send') {
    requireString(command.text, 'command.text', { max: 120_000 });
    if (command.agentId !== undefined) requireString(command.agentId, 'command.agentId', { max: 256 });
    if (command.conversationId !== undefined) requireString(command.conversationId, 'command.conversationId', { max: 256 });
  }
  return command;
}

export function makeRun({ requestId, ownerId, conversationId, agentId, text }) {
  const runId = randomUUID();
  return {
    runId,
    operationId: runId,
    executionKey: `run:${runId}:generation:1`,
    requestId,
    ownerId,
    conversationId,
    agentId,
    text,
    state: 'accepted',
    generation: 1,
    cancelled: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completedAt: null,
    error: null,
  };
}

export function publicRun(run) {
  return {
    runId: run.runId,
    operationId: run.operationId,
    requestId: run.requestId,
    conversationId: run.conversationId,
    agentId: run.agentId,
    state: run.state,
    generation: run.generation,
    ...(run.currentStep ? { currentStep: run.currentStep } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    error: run.error,
  };
}
