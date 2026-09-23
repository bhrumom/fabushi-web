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

export class HostRuntime {
  constructor({ dataDir = process.env.FABUSHI_HOST_DATA_DIR || path.resolve('.data/host'), runnerUrl = process.env.FABUSHI_RUNNER_URL || 'http://127.0.0.1:8790', internalToken = process.env.FABUSHI_INTERNAL_TOKEN || '' } = {}) {
    this.runnerUrl = runnerUrl.replace(/\/$/, '');
    this.internalToken = internalToken;
    this.store = new AtomicJsonStore(path.join(dataDir, 'turns.json'), () => ({ version: 1, executions: {} }));
    this.active = new Map();
  }

  async runTurn(input, onEvent) {
    const turn = this.#validateTurn(input);
    const state = await this.store.read();
    const persisted = state.executions[turn.executionKey];
    if (persisted?.status === 'completed' || persisted?.status === 'failed' || persisted?.status === 'cancelled') {
      for (const event of persisted.events ?? []) await onEvent(event);
      return;
    }
    const existing = this.active.get(turn.executionKey);
    if (existing) {
      for (const event of existing.events) await onEvent(event);
      existing.subscribers.add(onEvent);
      try { await existing.done; } finally { existing.subscribers.delete(onEvent); }
      return;
    }
    const active = { runId: turn.runId, events: [], subscribers: new Set([onEvent]), done: null, controller: new AbortController() };
    active.done = this.#executeTurn(turn, active).finally(() => this.active.delete(turn.executionKey));
    this.active.set(turn.executionKey, active);
    await active.done;
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
        record.events ??= [];
        if (!record.events.some((event) => event?.type === 'operation.interrupted')) {
          record.events.push({ timestamp: nowIso(), operationId: runId, type: 'operation.interrupted' });
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
    return {
      runId: requireString(value.runId, 'runId', { max: 128 }),
      executionKey: requireString(value.executionKey, 'executionKey', { max: 256 }),
      ownerId: requireString(value.ownerId, 'ownerId', { max: 256 }),
      conversationId: requireString(value.conversationId, 'conversationId', { max: 256 }),
      agentId: requireString(value.agentId || 'assistant', 'agentId', { max: 256 }),
      text: requireString(value.text, 'text', { max: 120_000 }),
      model: typeof value.model === 'string' ? value.model.slice(0, 128) : undefined,
    };
  }

  async #executeTurn(turn, active) {
    const emit = async (event) => {
      const normalized = { timestamp: nowIso(), operationId: turn.runId, ...event };
      active.events.push(normalized);
      await this.store.update((state) => {
        state.executions[turn.executionKey] ??= { runId: turn.runId, status: 'running', events: [], createdAt: nowIso(), updatedAt: nowIso() };
        state.executions[turn.executionKey].events = active.events;
        state.executions[turn.executionKey].updatedAt = nowIso();
      });
      for (const subscriber of [...active.subscribers]) {
        try { await subscriber(normalized); } catch { active.subscribers.delete(subscriber); }
      }
    };
    try {
      throwIfCancelled(active.controller.signal);
      await emit({ type: 'operation.started', label: 'Agent run', interruptible: true });
      await emit({ type: 'chat.message', role: 'user', text: turn.text });
      await emit({ type: 'agent.step', stepId: 'prepare', kind: 'preparing', title: 'Preparing', status: 'running' });
      await emit({ type: 'agent.step', stepId: 'prepare', kind: 'preparing', title: 'Preparing', status: 'completed' });
      await emit({ type: 'agent.step', stepId: 'thinking', kind: 'thinking', title: 'Thinking', status: 'running' });
      const toolSpec = chooseTool(turn.text);
      let toolContext = null;
      if (toolSpec) {
        await emit({ type: 'agent.step', stepId: `tool:${toolSpec.tool}`, kind: 'tool', title: `Tool · ${toolSpec.tool}`, detail: 'Running', status: 'running' });
        const testStepDelay = Number(process.env.FABUSHI_HOST_TEST_STEP_DELAY_MS || 0);
        if (testStepDelay > 0 && process.env.NODE_ENV !== 'production') await cancellableDelay(testStepDelay, active.controller.signal);
        toolContext = await this.#runTool(turn, toolSpec, active.controller.signal);
        throwIfCancelled(active.controller.signal);
        await emit({ type: 'agent.step', stepId: `tool:${toolSpec.tool}`, kind: 'tool', title: `Tool · ${toolSpec.tool}`, detail: JSON.stringify(toolContext), status: 'completed' });
      }
      await emit({ type: 'agent.step', stepId: 'thinking', kind: 'thinking', title: 'Thinking', status: 'completed' });
      const provider = process.env.FABUSHI_HOST_TEST_PROVIDER === 'deterministic' ? 'deterministic-test' : 'configured-provider';
      const model = turn.model || process.env.FABUSHI_INFERENCE_MODEL || 'auto';
      await emit({ type: 'model.routed', provider, model, mode: 'agent' });
      throwIfCancelled(active.controller.signal);
      const answer = await this.#infer(turn, toolContext, active.controller.signal);
      throwIfCancelled(active.controller.signal);
      await emit({ type: 'agent.step', stepId: 'stream', kind: 'streaming', title: 'Streaming', status: 'running' });
      for (const delta of chunkText(answer)) {
        throwIfCancelled(active.controller.signal);
        await emit({ type: 'chat.delta', delta });
      }
      await emit({ type: 'chat.message', role: 'assistant', text: answer });
      await emit({ type: 'agent.step', stepId: 'stream', kind: 'streaming', title: 'Streaming', status: 'completed' });
      await emit({ type: 'operation.completed' });
      await this.store.update((state) => { state.executions[turn.executionKey].status = 'completed'; state.executions[turn.executionKey].updatedAt = nowIso(); });
    } catch (error) {
      if (active.controller.signal.aborted || error?.code === 'TURN_CANCELLED') {
        await emit({ type: 'operation.interrupted' });
        await this.store.update((state) => {
          state.executions[turn.executionKey] ??= { runId: turn.runId, events: active.events, createdAt: nowIso() };
          state.executions[turn.executionKey].status = 'cancelled';
          state.executions[turn.executionKey].updatedAt = nowIso();
        });
        return;
      }
      const failure = errorEnvelope(error);
      await emit({ type: 'operation.failed', code: failure.code, message: failure.message });
      await this.store.update((state) => {
        state.executions[turn.executionKey] ??= { runId: turn.runId, events: active.events, createdAt: nowIso() };
        state.executions[turn.executionKey].status = 'failed';
        state.executions[turn.executionKey].error = failure;
        state.executions[turn.executionKey].updatedAt = nowIso();
      });
    }
  }

  async #runTool(turn, spec, signal) {
    const response = await fetch(`${this.runnerUrl}/v1/tools/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { authorization: `Bearer ${this.internalToken}` } : {}) },
      body: JSON.stringify({ idempotencyKey: `${turn.executionKey}:tool:${spec.tool}`, tool: spec.tool, args: spec.args }),
      signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false || body?.error) throw new ProtocolError('RUNNER_FAILED', body?.error?.message || body?.message || `Runner failed with HTTP ${response.status}`);
    return body.result;
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
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
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
