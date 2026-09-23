import path from 'node:path';
import { AtomicJsonStore } from '../shared/atomic-json-store.mjs';
import { ProtocolError, asRecord, errorEnvelope, nowIso, requireString } from '../shared/protocol.mjs';

function chunkText(text, size = 28) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks.length ? chunks : [''];
}

function chooseTool(text) {
  if (/(?:\btime\b|\bdate\b|\bclock\b|current\s+time|what\s+day|几点|时间|日期|今天)/i.test(text)) return { tool: 'time.now', args: { timeZone: 'UTC' } };
  if (/(?:runtime|capabilit|system info|环境|运行时|能力)/i.test(text)) return { tool: 'runtime.capabilities', args: {} };
  return null;
}

function extractProviderText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const choice = payload?.choices?.[0];
  if (typeof choice?.message?.content === 'string') return choice.message.content;
  if (Array.isArray(choice?.message?.content)) return choice.message.content.map((part) => typeof part?.text === 'string' ? part.text : '').join('');
  if (Array.isArray(payload?.output)) return payload.output.flatMap((item) => Array.isArray(item?.content) ? item.content : []).map((part) => typeof part?.text === 'string' ? part.text : '').join('');
  return '';
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new ProtocolError('TURN_CANCELLED', 'Turn was cancelled');
}

async function cancellableDelay(ms, signal) {
  throwIfCancelled(signal);
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => finish(resolve), ms);
    const onAbort = () => {
      clearTimeout(timer);
      finish(() => reject(new ProtocolError('TURN_CANCELLED', 'Turn was cancelled')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function stableEventKey(event, deltaOrdinal = 0) {
  if (event?.type === 'operation.started') return 'operation.started';
  if (event?.type === 'operation.completed') return 'operation.completed';
  if (event?.type === 'operation.interrupted') return 'operation.interrupted';
  if (event?.type === 'operation.failed') return 'operation.failed';
  if (event?.type === 'chat.message') return event.role === 'user' ? 'chat.user' : 'chat.assistant';
  if (event?.type === 'chat.delta') return `chat.delta:${deltaOrdinal}`;
  if (event?.type === 'agent.step') return `agent.step:${String(event.stepId || event.kind || 'step')}:${String(event.status || 'unknown')}`;
  if (event?.type === 'model.routed') return 'model.routed';
  return `${String(event?.type || 'event')}:${deltaOrdinal}`;
}

function normalizePersistedEvents(events) {
  let deltaOrdinal = 0;
  return (Array.isArray(events) ? events : []).map((event, index) => {
    if (event?.type === 'chat.delta') deltaOrdinal += 1;
    const hostSeq = Number.isSafeInteger(event?.hostSeq) && event.hostSeq > 0 ? event.hostSeq : index + 1;
    const hostEventKey = typeof event?.hostEventKey === 'string' && event.hostEventKey ? event.hostEventKey : stableEventKey(event, event?.type === 'chat.delta' ? deltaOrdinal : index + 1);
    return { ...event, hostSeq, hostEventKey };
  });
}

function maxHostSeq(events) {
  return events.reduce((max, event) => Math.max(max, Number.isSafeInteger(event?.hostSeq) ? event.hostSeq : 0), 0);
}

function isTransientRunnerStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class HostRuntime {
  constructor({ dataDir = process.env.FABUSHI_HOST_DATA_DIR || path.resolve('.data/host'), runnerUrl = process.env.FABUSHI_RUNNER_URL || 'http://127.0.0.1:8790', internalToken = process.env.FABUSHI_INTERNAL_TOKEN || '' } = {}) {
    this.runnerUrl = runnerUrl.replace(/\/$/, '');
    this.internalToken = internalToken;
    this.store = new AtomicJsonStore(path.join(dataDir, 'turns.json'), () => ({ version: 2, executions: {}, runGenerations: {} }));
    this.active = new Map();
  }

  async runTurn(input, onEvent) {
    const turn = this.#validateTurn(input);
    await this.#claimGeneration(turn);
    const state = await this.store.read();
    const persisted = state.executions[turn.executionKey];
    const persistedEvents = normalizePersistedEvents(persisted?.events);
    if (persisted?.status === 'completed' || persisted?.status === 'failed' || persisted?.status === 'cancelled') {
      for (const event of persistedEvents) await onEvent(event);
      return;
    }
    const existing = this.active.get(turn.executionKey);
    if (existing) {
      for (const event of existing.events) await onEvent(event);
      existing.subscribers.add(onEvent);
      try { await existing.done; } finally { existing.subscribers.delete(onEvent); }
      return;
    }
    const active = {
      runId: turn.runId,
      generation: turn.generation,
      events: persistedEvents,
      eventKeys: new Map(persistedEvents.map((event) => [event.hostEventKey, event])),
      nextSeq: maxHostSeq(persistedEvents),
      checkpoints: { ...(persisted?.checkpoints || {}) },
      subscribers: new Set([onEvent]),
      done: null,
      controller: new AbortController(),
    };
    await this.store.update((draft) => {
      draft.version = Math.max(Number(draft.version || 1), 2);
      draft.runGenerations ??= {};
      draft.runGenerations[turn.runId] = Math.max(Number(draft.runGenerations[turn.runId] || 0), turn.generation);
      draft.executions[turn.executionKey] ??= { runId: turn.runId, generation: turn.generation, status: 'running', events: [], checkpoints: {}, createdAt: nowIso(), updatedAt: nowIso() };
      draft.executions[turn.executionKey].events = active.events;
      draft.executions[turn.executionKey].checkpoints = active.checkpoints;
      draft.executions[turn.executionKey].generation = turn.generation;
      draft.executions[turn.executionKey].status = 'running';
      draft.executions[turn.executionKey].updatedAt = nowIso();
    });
    for (const event of active.events) await onEvent(event);
    active.done = this.#executeTurn(turn, active).finally(() => this.active.delete(turn.executionKey));
    this.active.set(turn.executionKey, active);
    await active.done;
  }

  async #claimGeneration(turn) {
    const staleActive = [];
    await this.store.update((state) => {
      state.version = Math.max(Number(state.version || 1), 2);
      state.runGenerations ??= {};
      state.executions ??= {};
      const current = Number(state.runGenerations[turn.runId] || 0);
      if (turn.generation < current) throw new ProtocolError('STALE_GENERATION', `Run generation ${turn.generation} is stale; latest is ${current}`);
      if (turn.generation > current) {
        state.runGenerations[turn.runId] = turn.generation;
        for (const [executionKey, record] of Object.entries(state.executions)) {
          if (record?.runId !== turn.runId || Number(record?.generation || 0) >= turn.generation) continue;
          if (record.status === 'running') {
            record.status = 'cancelled';
            record.updatedAt = nowIso();
            record.error = { code: 'STALE_GENERATION', message: `Superseded by generation ${turn.generation}` };
          }
          staleActive.push(executionKey);
        }
      } else if (!current) {
        state.runGenerations[turn.runId] = turn.generation;
      }
    });
    for (const executionKey of staleActive) this.active.get(executionKey)?.controller.abort();
  }

  async cancelTurn(input) {
    const value = asRecord(input);
    if (!value) throw new ProtocolError('INVALID_ARGUMENT', 'Host cancellation request must be an object');
    const executionKey = requireString(value.executionKey, 'executionKey', { max: 256 });
    const runId = requireString(value.runId, 'runId', { max: 128 });
    const active = this.active.get(executionKey);
    if (active) {
      if (active.runId !== runId) throw new ProtocolError('RUN_MISMATCH', 'Cancellation runId does not match active execution');
      active.controller.abort();
      await active.done.catch(() => undefined);
    } else {
      await this.store.update((state) => {
        const record = state.executions[executionKey];
        if (!record) throw new ProtocolError('TURN_NOT_FOUND', 'Host execution not found');
        if (record.runId !== runId) throw new ProtocolError('RUN_MISMATCH', 'Cancellation runId does not match persisted execution');
        if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') return;
        record.events = normalizePersistedEvents(record.events);
        if (!record.events.some((event) => event?.type === 'operation.interrupted')) {
          const hostSeq = maxHostSeq(record.events) + 1;
          record.events.push({ timestamp: nowIso(), operationId: runId, type: 'operation.interrupted', hostSeq, hostEventKey: 'operation.interrupted' });
        }
        record.status = 'cancelled';
        record.updatedAt = nowIso();
      });
    }
    const latest = await this.store.read();
    const record = latest.executions[executionKey];
    if (!record) throw new ProtocolError('TURN_NOT_FOUND', 'Host execution not found');
    return { runId, executionKey, state: record.status };
  }

  #validateTurn(input) {
    const value = asRecord(input);
    if (!value) throw new ProtocolError('INVALID_ARGUMENT', 'Host turn request must be an object');
    const runId = requireString(value.runId, 'runId', { max: 128 });
    const executionKey = requireString(value.executionKey, 'executionKey', { max: 256 });
    const prefix = `run:${runId}:generation:`;
    if (!executionKey.startsWith(prefix)) throw new ProtocolError('STALE_GENERATION', 'executionKey does not belong to runId');
    const generation = Number(executionKey.slice(prefix.length));
    if (!Number.isSafeInteger(generation) || generation < 1) throw new ProtocolError('STALE_GENERATION', 'executionKey generation is invalid');
    return {
      runId,
      executionKey,
      generation,
      ownerId: requireString(value.ownerId, 'ownerId', { max: 256 }),
      conversationId: requireString(value.conversationId, 'conversationId', { max: 256 }),
      agentId: requireString(value.agentId || 'assistant', 'agentId', { max: 256 }),
      text: requireString(value.text, 'text', { max: 120_000 }),
      model: typeof value.model === 'string' ? value.model.slice(0, 128) : undefined,
    };
  }

  async #executeTurn(turn, active) {
    const persist = async () => {
      await this.store.update((state) => {
        state.executions[turn.executionKey] ??= { runId: turn.runId, generation: turn.generation, status: 'running', events: [], checkpoints: {}, createdAt: nowIso(), updatedAt: nowIso() };
        state.executions[turn.executionKey].events = active.events;
        state.executions[turn.executionKey].checkpoints = active.checkpoints;
        state.executions[turn.executionKey].generation = turn.generation;
        state.executions[turn.executionKey].updatedAt = nowIso();
      });
    };
    const checkpoint = async (name, value) => {
      active.checkpoints[name] = value;
      await persist();
      return value;
    };
    const emit = async (hostEventKey, event) => {
      const existing = active.eventKeys.get(hostEventKey);
      if (existing) return existing;
      const normalized = { timestamp: nowIso(), operationId: turn.runId, ...event, hostSeq: ++active.nextSeq, hostEventKey };
      active.events.push(normalized);
      active.eventKeys.set(hostEventKey, normalized);
      await persist();
      for (const subscriber of [...active.subscribers]) {
        try { await subscriber(normalized); } catch { active.subscribers.delete(subscriber); }
      }
      return normalized;
    };
    try {
      throwIfCancelled(active.controller.signal);
      await emit('operation.started', { type: 'operation.started', label: 'Agent run', interruptible: true });
      await emit('chat.user', { type: 'chat.message', role: 'user', text: turn.text });
      await emit('agent.step:prepare:running', { type: 'agent.step', stepId: 'prepare', kind: 'preparing', title: 'Preparing', status: 'running' });
      await emit('agent.step:prepare:completed', { type: 'agent.step', stepId: 'prepare', kind: 'preparing', title: 'Preparing', status: 'completed' });
      await emit('agent.step:thinking:running', { type: 'agent.step', stepId: 'thinking', kind: 'thinking', title: 'Thinking', status: 'running' });
      const toolSpec = chooseTool(turn.text);
      let toolContext = Object.prototype.hasOwnProperty.call(active.checkpoints, 'toolContext') ? active.checkpoints.toolContext : null;
      if (toolSpec) {
        await emit(`agent.step:tool:${toolSpec.tool}:running`, { type: 'agent.step', stepId: `tool:${toolSpec.tool}`, kind: 'tool', title: `Tool · ${toolSpec.tool}`, detail: 'Running', status: 'running' });
        if (!Object.prototype.hasOwnProperty.call(active.checkpoints, 'toolContext')) {
          const testStepDelay = Number(process.env.FABUSHI_HOST_TEST_STEP_DELAY_MS || 0);
          if (testStepDelay > 0 && process.env.NODE_ENV !== 'production') await cancellableDelay(testStepDelay, active.controller.signal);
          toolContext = await this.#runTool(turn, toolSpec, active.controller.signal);
          await checkpoint('toolContext', toolContext);
        }
        throwIfCancelled(active.controller.signal);
        await emit(`agent.step:tool:${toolSpec.tool}:completed`, { type: 'agent.step', stepId: `tool:${toolSpec.tool}`, kind: 'tool', title: `Tool · ${toolSpec.tool}`, detail: JSON.stringify(toolContext), status: 'completed' });
      }
      await emit('agent.step:thinking:completed', { type: 'agent.step', stepId: 'thinking', kind: 'thinking', title: 'Thinking', status: 'completed' });
      const provider = process.env.FABUSHI_HOST_TEST_PROVIDER === 'deterministic' ? 'deterministic-test' : 'configured-provider';
      const model = turn.model || process.env.FABUSHI_INFERENCE_MODEL || 'auto';
      await emit('model.routed', { type: 'model.routed', provider, model, mode: 'agent' });
      throwIfCancelled(active.controller.signal);
      let answer = active.checkpoints.answer;
      if (typeof answer !== 'string') {
        answer = await this.#infer(turn, toolContext, active.controller.signal);
        await checkpoint('answer', answer);
      }
      throwIfCancelled(active.controller.signal);
      await emit('agent.step:stream:running', { type: 'agent.step', stepId: 'stream', kind: 'streaming', title: 'Streaming', status: 'running' });
      const deltas = chunkText(answer);
      for (let index = 0; index < deltas.length; index += 1) {
        throwIfCancelled(active.controller.signal);
        await emit(`chat.delta:${index + 1}`, { type: 'chat.delta', delta: deltas[index] });
      }
      await emit('chat.assistant', { type: 'chat.message', role: 'assistant', text: answer });
      await emit('agent.step:stream:completed', { type: 'agent.step', stepId: 'stream', kind: 'streaming', title: 'Streaming', status: 'completed' });
      await emit('operation.completed', { type: 'operation.completed' });
      await this.store.update((state) => { state.executions[turn.executionKey].status = 'completed'; state.executions[turn.executionKey].updatedAt = nowIso(); });
    } catch (error) {
      if (active.controller.signal.aborted || error?.code === 'TURN_CANCELLED') {
        await emit('operation.interrupted', { type: 'operation.interrupted' });
        await this.store.update((state) => {
          state.executions[turn.executionKey] ??= { runId: turn.runId, generation: turn.generation, events: active.events, checkpoints: active.checkpoints, createdAt: nowIso() };
          state.executions[turn.executionKey].status = 'cancelled';
          state.executions[turn.executionKey].updatedAt = nowIso();
        });
        return;
      }
      const failure = errorEnvelope(error);
      await emit('operation.failed', { type: 'operation.failed', code: failure.code, message: failure.message });
      await this.store.update((state) => {
        state.executions[turn.executionKey] ??= { runId: turn.runId, generation: turn.generation, events: active.events, checkpoints: active.checkpoints, createdAt: nowIso() };
        state.executions[turn.executionKey].status = 'failed';
        state.executions[turn.executionKey].error = failure;
        state.executions[turn.executionKey].updatedAt = nowIso();
      });
    }
  }

  async #runTool(turn, spec, signal) {
    const maxAttempts = Math.max(1, Number(process.env.FABUSHI_RUNNER_RECOVERY_ATTEMPTS || 6));
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfCancelled(signal);
      try {
        const response = await fetch(`${this.runnerUrl}/v1/tools/execute`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.internalToken ? { authorization: `Bearer ${this.internalToken}` } : {}) },
          body: JSON.stringify({ idempotencyKey: `${turn.executionKey}:tool:${spec.tool}`, tool: spec.tool, args: spec.args }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(Number(process.env.FABUSHI_RUNNER_TIMEOUT_MS || 30_000))]),
        });
        const body = await response.json().catch(() => ({}));
        if (response.ok && body?.ok !== false && !body?.error) return body.result;
        const failure = new ProtocolError('RUNNER_FAILED', body?.error?.message || body?.message || `Runner failed with HTTP ${response.status}`);
        if (!isTransientRunnerStatus(response.status) || attempt === maxAttempts) throw failure;
        lastError = failure;
      } catch (error) {
        if (signal?.aborted || error?.code === 'TURN_CANCELLED') throw error;
        lastError = error;
        if (error?.code === 'RUNNER_FAILED' && attempt === maxAttempts) throw error;
        if (attempt === maxAttempts) break;
      }
      await cancellableDelay(Math.min(1_500, 100 * 2 ** (attempt - 1)), signal);
    }
    throw new ProtocolError('RUNNER_UNAVAILABLE', lastError instanceof Error ? lastError.message : 'Runner is unavailable');
  }

  async #infer(turn, toolContext, signal) {
    throwIfCancelled(signal);
    if (process.env.FABUSHI_HOST_TEST_PROVIDER === 'deterministic') {
      const toolLine = toolContext ? ` Tool result: ${JSON.stringify(toolContext)}.` : '';
      return `Completed durable run ${turn.runId}.${toolLine} Response to: ${turn.text}`;
    }
    const endpoint = process.env.FABUSHI_INFERENCE_URL;
    if (!endpoint) throw new ProtocolError('PROVIDER_NOT_CONFIGURED', 'FABUSHI_INFERENCE_URL is required for production Host inference');
    const apiKey = process.env.FABUSHI_INFERENCE_API_KEY;
    const messages = [
      { role: 'system', content: 'You are the Fabushi Web Host. Use provided tool results as trusted runtime observations.' },
      { role: 'user', content: turn.text },
      ...(toolContext ? [{ role: 'system', content: `Tool result: ${JSON.stringify(toolContext)}` }] : []),
    ];
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fabushi-idempotency-key': `${turn.executionKey}:inference`, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: turn.model || process.env.FABUSHI_INFERENCE_MODEL || 'auto', messages, stream: false }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(Number(process.env.FABUSHI_INFERENCE_TIMEOUT_MS || 120_000))]),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ProtocolError('PROVIDER_FAILED', payload?.error?.message || `Inference HTTP ${response.status}`);
    const text = extractProviderText(payload).trim();
    if (!text) throw new ProtocolError('PROVIDER_EMPTY', 'Inference provider returned no text');
    return text;
  }
}
