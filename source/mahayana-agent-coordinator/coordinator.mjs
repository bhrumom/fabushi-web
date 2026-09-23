import path from 'node:path';
import { AtomicJsonStore } from '../shared/atomic-json-store.mjs';
import { ProtocolError, TERMINAL_RUN_STATES, errorEnvelope, makeRun, nowIso, publicRun, requireString, validateRuntimeCommand } from '../shared/protocol.mjs';

const DEFAULT_AGENT_ID = 'assistant';
const DEFAULT_CONVERSATION_ID = 'mahayana-ai:agent:assistant';
function initialState() {
  return { version: 1, nextSeq: 1, runs: {}, requestIndex: {}, events: [], conversations: { [DEFAULT_CONVERSATION_ID]: { id: DEFAULT_CONVERSATION_ID, title: 'Mahayana（大乘 AI）', kind: 'agent', pinned: true, updatedAtMs: Date.now(), messages: [] } } };
}
function eventRunState(event, current) {
  if (event.type === 'operation.completed') return 'completed';
  if (event.type === 'operation.failed') return 'failed';
  if (event.type === 'operation.interrupted') return 'cancelled';
  if (event.type === 'agent.step' && event.status === 'running') {
    if (event.kind === 'preparing') return 'preparing';
    if (event.kind === 'thinking') return 'thinking';
    if (event.kind === 'tool') return 'tool-running';
    if (event.kind === 'streaming') return 'streaming';
  }
  return current;
}

export class MahayanaCoordinatorService {
  constructor({ dataDir = process.env.FABUSHI_COORDINATOR_DATA_DIR || path.resolve('.data/coordinator'), hostUrl = process.env.FABUSHI_HOST_URL || 'http://127.0.0.1:8789', internalToken = process.env.FABUSHI_INTERNAL_TOKEN || '' } = {}) {
    this.hostUrl = hostUrl.replace(/\/$/, '');
    this.internalToken = internalToken;
    this.store = new AtomicJsonStore(path.join(dataDir, 'state.json'), initialState);
    this.executing = new Set();
  }
  async initialize() {
    const state = await this.store.read();
    const active = Object.values(state.runs).filter((run) => !TERMINAL_RUN_STATES.has(run.state));
    for (const run of active) {
      await this.store.update((draft) => {
        const target = draft.runs[run.runId];
        if (!target || TERMINAL_RUN_STATES.has(target.state)) return;
        target.state = 'recovering';
        target.updatedAt = nowIso();
        this.#appendEvent(draft, target.ownerId, target.runId, target.conversationId, { type: 'agent.step', operationId: target.runId, stepId: 'recovering', kind: 'recovering', title: 'Recovering durable run', status: 'running', timestamp: nowIso() });
      });
      void this.#executeRun(run.runId);
    }
  }
  async request(ownerId, method, args = {}) {
    const owner = requireString(ownerId, 'ownerId', { max: 256 });
    switch (method) {
      case 'runtime.execute': return await this.#executeCommand(owner, validateRuntimeCommand(args.command));
      case 'runtime.interrupt': return await this.interrupt(owner, requireString(args.operationId, 'operationId', { max: 128 }));
      case 'runtime.resync': return await this.resync(owner, Number(args.afterSeq || 0));
      case 'runtime.run': return await this.getRun(owner, requireString(args.runId, 'runId', { max: 128 }));
      default: throw new ProtocolError('METHOD_NOT_FOUND', `Coordinator method is not supported: ${method}`);
    }
  }
  async #executeCommand(ownerId, command) {
    switch (command.type) {
      case 'chat.send': return await this.#acceptTurn(ownerId, command);
      case 'conversation.list': return await this.#emitConversationList(ownerId, command);
      case 'conversation.open': return await this.#emitConversationOpen(ownerId, command);
      case 'bot.list': return await this.#emit(ownerId, command, { type: 'bot.listed', bots: [{ id: DEFAULT_AGENT_ID, name: 'Mahayana', description: 'Durable Fabushi Web agent', title: 'Mahayana', hidden: false, notificationsEnabled: true, notifyOnUpdates: true, unread: false, conversationId: DEFAULT_CONVERSATION_ID }] });
      case 'capability.list': return await this.#emit(ownerId, command, { type: 'capability.listed', capabilities: [{ id: DEFAULT_AGENT_ID, title: 'Mahayana', kind: 'agent', mention: '@mahayana', conversationId: DEFAULT_CONVERSATION_ID, provider: 'mahayana-web', description: 'Durable Web Agent', requiredPermissions: [], availability: 'ready' }] });
      case 'automation.list': return await this.#emit(ownerId, command, { type: 'automation.listed', automations: [] });
      case 'group.list': return await this.#emit(ownerId, command, { type: 'group.listed', groups: [] });
      case 'skill.list': return await this.#emit(ownerId, command, { type: 'skill.listed', skills: [], teams: [] });
      case 'connector.list': return await this.#emit(ownerId, command, { type: 'connector.listed', connectors: [] });
      case 'listener.list': return await this.#emit(ownerId, command, { type: 'listener.listed', integrations: [] });
      case 'subagent.list': return await this.#emit(ownerId, command, { type: 'subagent.listed', agentId: command.agentId, subagents: [] });
      case 'asyncTask.list': return await this.#emit(ownerId, command, { type: 'asyncTask.listed', agentId: command.agentId, tasks: [] });
      case 'session.clear': return await this.#emit(ownerId, command, { type: 'session.cleared' });
      default: throw new ProtocolError('COMMAND_NOT_IMPLEMENTED', `Runtime command is not implemented by Web Coordinator yet: ${command.type}`);
    }
  }
  async #acceptTurn(ownerId, command) {
    const requestKey = `${ownerId}:${command.requestId}`;
    let result;
    await this.store.update((state) => {
      const existingRunId = state.requestIndex[requestKey];
      if (existingRunId && state.runs[existingRunId]) { result = { requestId: command.requestId, operationId: existingRunId, deduplicated: true }; return; }
      const conversationId = command.conversationId || DEFAULT_CONVERSATION_ID;
      state.conversations[conversationId] ??= { id: conversationId, title: command.text.slice(0, 72), kind: 'agent', pinned: false, updatedAtMs: Date.now(), messages: [] };
      const run = makeRun({ requestId: command.requestId, ownerId, conversationId, agentId: command.agentId || DEFAULT_AGENT_ID, text: command.text });
      run.model = command.model;
      run.mode = command.mode || 'agent';
      run.hostEventIndex = 0;
      state.runs[run.runId] = run;
      state.requestIndex[requestKey] = run.runId;
      this.#appendEvent(state, ownerId, run.runId, conversationId, { type: 'agent.step', operationId: run.runId, stepId: 'accepted', kind: 'accepted', title: 'Turn accepted', status: 'completed', timestamp: nowIso() });
      result = { requestId: command.requestId, operationId: run.runId, deduplicated: false };
    });
    void this.#executeRun(result.operationId);
    return result;
  }
  async #executeRun(runId) {
    if (this.executing.has(runId)) return;
    this.executing.add(runId);
    try {
      const snapshot = await this.store.read();
      const run = snapshot.runs[runId];
      if (!run || TERMINAL_RUN_STATES.has(run.state) || run.cancelled) return;
      const response = await fetch(`${this.hostUrl}/v1/turn`, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.internalToken ? { authorization: `Bearer ${this.internalToken}` } : {}) }, body: JSON.stringify({ runId: run.runId, executionKey: run.executionKey, ownerId: run.ownerId, conversationId: run.conversationId, agentId: run.agentId, text: run.text, model: run.model }) });
      if (!response.ok || !response.body) throw new ProtocolError('HOST_UNAVAILABLE', `Host returned HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let hostIndex = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!line) continue;
          hostIndex += 1;
          await this.#acceptHostEvent(runId, hostIndex, JSON.parse(line));
        }
      }
      if (pending.trim()) { hostIndex += 1; await this.#acceptHostEvent(runId, hostIndex, JSON.parse(pending)); }
    } catch (error) {
      await this.store.update((state) => {
        const run = state.runs[runId];
        if (!run || TERMINAL_RUN_STATES.has(run.state) || run.cancelled) return;
        run.state = 'failed';
        run.error = errorEnvelope(error);
        run.updatedAt = nowIso();
        run.completedAt = nowIso();
        this.#appendEvent(state, run.ownerId, run.runId, run.conversationId, { type: 'operation.failed', operationId: run.runId, code: run.error.code, message: run.error.message, timestamp: nowIso() });
      });
    } finally { this.executing.delete(runId); }
  }
  async #acceptHostEvent(runId, hostIndex, event) {
    await this.store.update((state) => {
      const run = state.runs[runId];
      if (!run || run.cancelled || TERMINAL_RUN_STATES.has(run.state)) return;
      if (hostIndex <= (run.hostEventIndex || 0)) return;
      run.hostEventIndex = hostIndex;
      run.state = eventRunState(event, run.state);
      run.updatedAt = nowIso();
      if (run.state === 'completed' || run.state === 'failed') run.completedAt = nowIso();
      if (event.type === 'operation.failed') run.error = { code: event.code, message: event.message };
      if (event.type === 'chat.message') {
        const conversation = state.conversations[run.conversationId];
        if (conversation) {
          const messageId = `${run.runId}:${hostIndex}`;
          if (!conversation.messages.some((message) => message.id === messageId)) {
            conversation.messages.push({ id: messageId, role: event.role === 'user' ? 'user' : 'assistant', text: String(event.text || ''), createdAtMs: Date.now(), runId: run.runId });
            conversation.updatedAtMs = Date.now();
          }
        }
      }
      this.#appendEvent(state, run.ownerId, run.runId, run.conversationId, event);
    });
  }
  async interrupt(ownerId, runId) {
    let found = false;
    await this.store.update((state) => {
      const run = state.runs[runId];
      if (!run || run.ownerId !== ownerId) return;
      found = true;
      if (TERMINAL_RUN_STATES.has(run.state)) return;
      run.cancelled = true;
      run.state = 'cancelled';
      run.updatedAt = nowIso();
      run.completedAt = nowIso();
      this.#appendEvent(state, ownerId, runId, run.conversationId, { type: 'operation.interrupted', operationId: runId, timestamp: nowIso() });
    });
    if (!found) throw new ProtocolError('NOT_FOUND', 'Run not found');
    return { operationId: runId, state: 'cancelled' };
  }
  async getRun(ownerId, runId) {
    const state = await this.store.read();
    const run = state.runs[runId];
    if (!run || run.ownerId !== ownerId) throw new ProtocolError('NOT_FOUND', 'Run not found');
    return publicRun(run);
  }
  async resync(ownerId, afterSeq = 0) {
    const state = await this.store.read();
    const cursor = Number.isSafeInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
    const events = state.events.filter((event) => event.ownerId === ownerId && event.seq > cursor).slice(0, 1000);
    const activeRuns = Object.values(state.runs).filter((run) => run.ownerId === ownerId && !TERMINAL_RUN_STATES.has(run.state)).map(publicRun);
    const nextSeq = events.length ? events[events.length - 1].seq : cursor;
    return { events, activeRuns, nextSeq, highWaterMark: state.nextSeq - 1 };
  }
  async pollEvents(ownerId, afterSeq = 0, timeoutMs = 20_000) {
    const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 0, 0), 25_000);
    do {
      const result = await this.resync(ownerId, afterSeq);
      if (result.events.length || Date.now() >= deadline) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return await this.resync(ownerId, afterSeq);
  }
  async #emitConversationList(ownerId, command) {
    const state = await this.store.read();
    const conversations = Object.values(state.conversations).map(({ messages, ...conversation }) => ({ ...conversation, unreadCount: 0 })).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    return await this.#emit(ownerId, command, { type: 'conversation.listed', conversations });
  }
  async #emitConversationOpen(ownerId, command) {
    const state = await this.store.read();
    const conversation = state.conversations[command.conversationId];
    return await this.#emit(ownerId, command, { type: 'conversation.opened', conversationId: command.conversationId, messages: conversation?.messages ?? [] });
  }
  async #emit(ownerId, command, event) {
    await this.store.update((state) => { this.#appendEvent(state, ownerId, null, event.conversationId || DEFAULT_CONVERSATION_ID, { ...event, timestamp: nowIso() }); });
    return { requestId: command.requestId };
  }
  #appendEvent(state, ownerId, runId, conversationId, event) {
    const record = { seq: state.nextSeq++, ownerId, runId, conversationId, timestamp: event.timestamp || nowIso(), event };
    state.events.push(record);
    if (state.events.length > 50_000) state.events.splice(0, state.events.length - 50_000);
    return record;
  }
}
