import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AtomicJsonStore } from '../shared/atomic-json-store.mjs';
import { ProtocolError, TERMINAL_RUN_STATES, errorEnvelope, makeRun, nowIso, publicRun, requireString, validateRuntimeCommand } from '../shared/protocol.mjs';

const DEFAULT_AGENT_ID = 'assistant';
const DEFAULT_CONVERSATION_ID = 'mahayana-ai:agent:assistant';
function initialState() {
  return { version: 2, nextSeq: 1, runs: {}, requestIndex: {}, approvals: {}, events: [], conversationsByOwner: {}, peerMessagesByOwner: {} };
}
function defaultConversation() {
  return { id: DEFAULT_CONVERSATION_ID, title: 'Mahayana（大乘 AI）', kind: 'agent', pinned: true, updatedAtMs: Date.now(), messages: [] };
}
function ownerConversations(state, ownerId, create = false) {
  state.conversationsByOwner ??= {};
  if (create) {
    state.conversationsByOwner[ownerId] ??= {};
    state.conversationsByOwner[ownerId][DEFAULT_CONVERSATION_ID] ??= defaultConversation();
  }
  return state.conversationsByOwner[ownerId] ?? {};
}
function ownerPeerMessages(state, ownerId, create = false) {
  state.peerMessagesByOwner ??= {};
  if (create) state.peerMessagesByOwner[ownerId] ??= [];
  return state.peerMessagesByOwner[ownerId] ?? [];
}
function appendPeerMessage(state, ownerId, message) {
  const messages = ownerPeerMessages(state, ownerId, true);
  if (!messages.some((candidate) => candidate.id === message.id)) messages.push(message);
  if (messages.length > 2000) messages.splice(0, messages.length - 2000);
}
function migrateConversationOwnership(state) {
  if (state.version >= 2 && state.conversationsByOwner) return;
  const rebuilt = {};
  const ensure = (ownerId, conversationId) => {
    rebuilt[ownerId] ??= {};
    rebuilt[ownerId][conversationId] ??= {
      id: conversationId,
      title: conversationId === DEFAULT_CONVERSATION_ID ? 'Mahayana（大乘 AI）' : conversationId,
      kind: 'agent',
      pinned: conversationId === DEFAULT_CONVERSATION_ID,
      updatedAtMs: 0,
      messages: [],
    };
    return rebuilt[ownerId][conversationId];
  };
  for (const record of Array.isArray(state.events) ? state.events : []) {
    if (!record?.ownerId || record?.event?.type !== 'chat.message') continue;
    const conversationId = record.conversationId || DEFAULT_CONVERSATION_ID;
    const conversation = ensure(record.ownerId, conversationId);
    const text = String(record.event.text || '');
    const role = record.event.role === 'assistant' ? 'assistant' : 'user';
    const createdAtMs = Date.parse(record.timestamp || record.event.timestamp || '') || Date.now();
    const id = `${record.runId || 'event'}:${record.seq}`;
    if (!conversation.messages.some((message) => message.id === id)) {
      conversation.messages.push({ id, role, text, createdAtMs, ...(record.runId ? { runId: record.runId } : {}) });
      conversation.updatedAtMs = Math.max(conversation.updatedAtMs, createdAtMs);
      if (role === 'user' && conversation.title === conversationId) conversation.title = text.slice(0, 72) || conversation.title;
    }
  }
  for (const run of Object.values(state.runs || {})) {
    if (!run?.ownerId || !run?.conversationId) continue;
    ensure(run.ownerId, run.conversationId);
  }
  state.conversationsByOwner = rebuilt;
  delete state.conversations;
  state.version = 2;
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
    if (event.kind === 'recovering') return 'recovering';
  }
  return current;
}
function hostEventSequence(event, fallback) {
  return Number.isSafeInteger(event?.hostSeq) && event.hostSeq > 0 ? event.hostSeq : fallback;
}
function hostProtocolError(value, fallbackMessage = 'Host turn failed') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.error || value.type) return null;
  const failure = value.error && typeof value.error === 'object' && !Array.isArray(value.error) ? value.error : {};
  return new ProtocolError(
    typeof failure.code === 'string' && failure.code ? failure.code : 'HOST_FAILED',
    typeof failure.message === 'string' && failure.message ? failure.message : fallbackMessage,
    failure.details,
  );
}
function recoverableHostError(error) {
  if (!error || error.name === 'AbortError' || error.code === 'ABORT_ERR') return false;
  const code = typeof error.code === 'string' ? error.code : '';
  if (['STALE_GENERATION','INVALID_ARGUMENT','UNAUTHORIZED','OWNER_REQUIRED','PAYLOAD_TOO_LARGE','RUN_MISMATCH'].includes(code)) return false;
  return code.startsWith('HOST_') || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'UND_ERR_SOCKET' || error instanceof TypeError;
}
async function delayWithSignal(ms, signal) {
  if (signal?.aborted) throw Object.assign(new Error('Run aborted'), { name: 'AbortError' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Run aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export class MahayanaCoordinatorService {
  constructor({ dataDir = process.env.FABUSHI_COORDINATOR_DATA_DIR || path.resolve('.data/coordinator'), hostUrl = process.env.FABUSHI_HOST_URL || 'http://127.0.0.1:8789', internalToken = process.env.FABUSHI_INTERNAL_TOKEN || '' } = {}) {
    this.hostUrl = hostUrl.replace(/\/$/, '');
    this.internalToken = internalToken;
    this.store = new AtomicJsonStore(path.join(dataDir, 'state.json'), initialState);
    this.executing = new Set();
    this.abortControllers = new Map();
  }
  async initialize() {
    await this.store.update((draft) => { migrateConversationOwnership(draft); draft.peerMessagesByOwner ??= {}; });
    const state = await this.store.read();
    const active = Object.values(state.runs).filter((run) => !TERMINAL_RUN_STATES.has(run.state));
    for (const run of active) {
      await this.store.update((draft) => {
        const target = draft.runs[run.runId];
        if (!target || TERMINAL_RUN_STATES.has(target.state)) return;
        target.state = 'recovering';
        target.updatedAt = nowIso();
        target.currentStep = { stepId: 'recovering', kind: 'recovering', title: 'Recovering durable run', status: 'running' };
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
      case 'runtime.approval': return await this.resolveApproval(owner, args);
      case 'product.request': return await this.productRequest(owner, requireString(args.method, 'product.method', { max: 160 }), args.args || {});
      default: throw new ProtocolError('METHOD_NOT_FOUND', `Coordinator method is not supported: ${method}`);
    }
  }
  async #executeCommand(ownerId, command) {
    switch (command.type) {
      case 'chat.send': return await this.#acceptTurn(ownerId, command);
      case 'conversation.list': return await this.#emitConversationList(ownerId, command);
      case 'conversation.open': return await this.#emitConversationOpen(ownerId, command);
      case 'capability.list': return await this.#emit(ownerId, command, { type: 'capability.listed', capabilities: [{ id: DEFAULT_AGENT_ID, title: 'Mahayana', kind: 'agent', mention: '@mahayana', conversationId: DEFAULT_CONVERSATION_ID, provider: 'mahayana-web', description: 'Durable Web Agent', requiredPermissions: [], availability: 'ready' }] });
      case 'automation.list': return await this.#emit(ownerId, command, { type: 'automation.listed', automations: [] });
      case 'connector.list': return await this.#emit(ownerId, command, { type: 'connector.listed', connectors: [] });
      case 'listener.list': return await this.#emit(ownerId, command, { type: 'listener.listed', integrations: [] });
      case 'subagent.list': return await this.#emit(ownerId, command, { type: 'subagent.listed', agentId: command.agentId, subagents: [] });
      case 'asyncTask.list': return await this.#emit(ownerId, command, { type: 'asyncTask.listed', agentId: command.agentId, tasks: [] });
      case 'capability.request': return await this.#requestCapabilityApproval(ownerId, command);
      case 'search.messages': return await this.#searchMessages(ownerId, command);
      case 'agent.send': return await this.#sendAgent(ownerId, command);
      case 'agent.broadcast': return await this.#broadcastAgents(ownerId, command);
      case 'agent.peerHistory': return await this.#peerHistory(ownerId, command);
      case 'group.send': return await this.#sendGroup(ownerId, command);
      case 'bot.list':
      case 'bot.create':
      case 'bot.update':
      case 'bot.clone':
      case 'bot.delete':
      case 'bot.setHidden':
      case 'group.list':
      case 'group.create':
      case 'group.update':
      case 'group.delete':
      case 'skill.list':
      case 'skill.upsert':
      case 'skill.delete':
      case 'memory.list':
      case 'memory.add':
      case 'memory.remove':
      case 'memory.clear':
      case 'tray.list':
      case 'tray.dismiss':
      case 'tray.clear':
      case 'tray.clearForAgent':
      case 'settings.get':
      case 'settings.update':
      case 'mcp.list':
      case 'mcp.apps':
      case 'mcp.oauthLogin':
      case 'mcp.oauthLogout':
      case 'mcp.remove':
      case 'mcp.setCustomInstructions':
      case 'mcp.setToolDisabled':
      case 'mcp.refresh':
      case 'mcp.toolCall':
      case 'marketplace.install':
      case 'miniapp.open':
      case 'attachment.upload':
      case 'attachment.readText':
      case 'attachment.readChunk':
      case 'attachment.readImage':
      case 'search.media':
        return await this.#executeProductCommand(ownerId, command);
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
      const conversations = ownerConversations(state, ownerId, true);
      conversations[conversationId] ??= { id: conversationId, title: command.text.slice(0, 72), kind: 'agent', pinned: false, updatedAtMs: Date.now(), messages: [] };
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

  async #acceptBackgroundTurn(ownerId, input) {
    const requestKey = `${ownerId}:${input.requestId}`;
    let result;
    await this.store.update((state) => {
      const existingRunId = state.requestIndex[requestKey];
      if (existingRunId && state.runs[existingRunId]) {
        result = { requestId: input.requestId, operationId: existingRunId, deduplicated: true };
        return;
      }
      const conversationId = `mahayana-ai:agent:${input.agentId}`;
      const conversations = ownerConversations(state, ownerId, true);
      conversations[conversationId] ??= { id: conversationId, title: input.agentName, kind: 'agent', pinned: false, updatedAtMs: Date.now(), messages: [] };
      const run = makeRun({ requestId: input.requestId, ownerId, conversationId, agentId: input.agentId, text: input.text });
      run.mode = 'agent';
      run.hostEventIndex = 0;
      run.background = {
        source: input.source,
        agentName: input.agentName,
        ...(input.peerReplyTo ? { peerReplyTo: input.peerReplyTo } : {}),
        ...(input.groupId ? { groupId: input.groupId } : {}),
      };
      state.runs[run.runId] = run;
      state.requestIndex[requestKey] = run.runId;
      this.#appendEvent(state, ownerId, run.runId, conversationId, {
        type: 'agent.backgroundStarted',
        timestamp: nowIso(),
        agentId: input.agentId,
        agentName: input.agentName,
        operationId: run.runId,
        source: input.source,
      });
      result = { requestId: input.requestId, operationId: run.runId, deduplicated: false };
    });
    void this.#executeRun(result.operationId);
    return result;
  }

  async #botIndex(ownerId) {
    const bots = await this.productRequest(ownerId, 'state.bot.list', {});
    return new Map((Array.isArray(bots) ? bots : []).map((bot) => [bot.id, bot]));
  }

  async #sendAgent(ownerId, command) {
    const requestKey = `${ownerId}:${command.requestId}`;
    const current = await this.store.read();
    const existingRunId = current.requestIndex?.[requestKey];
    if (existingRunId && current.runs?.[existingRunId]) return { requestId: command.requestId, operationId: existingRunId, deduplicated: true };
    const bots = await this.#botIndex(ownerId);
    const fromAgentId = requireString(command.fromAgentId, 'fromAgentId', { max: 256 });
    const targetId = requireString(command.targetId, 'targetId', { max: 256 });
    const from = bots.get(fromAgentId);
    const target = bots.get(targetId);
    if (!from) throw new ProtocolError('BOT_NOT_FOUND', `Source agent not found: ${fromAgentId}`);
    if (!target) throw new ProtocolError('BOT_NOT_FOUND', `Target agent not found: ${targetId}`);
    const text = requireString(command.text, 'agent.text', { max: 120_000 });
    const message = {
      id: `peer-${randomUUID()}`,
      fromAgentId,
      fromAgentName: from.name,
      targetId,
      targetName: target.name,
      text,
      priority: Boolean(command.priority),
      createdAtMs: Date.now(),
    };
    await this.store.update((state) => {
      appendPeerMessage(state, ownerId, message);
      this.#appendEvent(state, ownerId, null, `mahayana-ai:agent:${targetId}`, { type: 'agent.peerMessage', timestamp: nowIso(), message });
    });
    return await this.#acceptBackgroundTurn(ownerId, {
      requestId: command.requestId,
      agentId: targetId,
      agentName: target.name,
      text: `Message from ${from.name}: ${text}`,
      source: `agent:${fromAgentId}`,
      peerReplyTo: { id: fromAgentId, name: from.name },
    });
  }

  async #broadcastAgents(ownerId, command) {
    const bots = await this.#botIndex(ownerId);
    const requested = Array.isArray(command.targetIds) ? command.targetIds.map((id) => requireString(id, 'targetId', { max: 256 })) : [...bots.keys()];
    const targetIds = [...new Set(requested)].filter((id) => bots.has(id)).slice(0, 32);
    const message = requireString(command.message, 'broadcast.message', { max: 120_000 });
    let scheduled = 0;
    for (const targetId of targetIds) {
      const target = bots.get(targetId);
      const result = await this.#acceptBackgroundTurn(ownerId, {
        requestId: `${command.requestId}:broadcast:${targetId}`,
        agentId: targetId,
        agentName: target.name,
        text: `Broadcast from user: ${message}`,
        source: 'broadcast:user',
      });
      if (!result.deduplicated) scheduled += 1;
    }
    const result = { total: targetIds.length, scheduled };
    await this.store.update((state) => {
      this.#appendEvent(state, ownerId, null, DEFAULT_CONVERSATION_ID, { type: 'agent.broadcasted', timestamp: nowIso(), result });
    });
    return { requestId: command.requestId };
  }

  async #peerHistory(ownerId, command) {
    const agentId = requireString(command.agentId, 'agentId', { max: 256 });
    const limit = Number.isSafeInteger(command.limit) ? Math.min(Math.max(command.limit, 1), 300) : 100;
    const state = await this.store.read();
    const messages = ownerPeerMessages(state, ownerId, false)
      .filter((message) => message.fromAgentId === agentId || message.targetId === agentId)
      .slice(-limit);
    return await this.#emit(ownerId, command, { type: 'agent.peerHistory', agentId, messages });
  }

  async #sendGroup(ownerId, command) {
    const groupId = requireString(command.id, 'group.id', { max: 256 });
    const text = requireString(command.text, 'group.text', { max: 120_000 });
    let group = await this.productRequest(ownerId, 'state.group.get', { id: groupId });
    group = await this.productRequest(ownerId, 'state.group.appendMessage', { id: groupId, speaker: { kind: 'user' }, content: text });
    await this.store.update((state) => {
      this.#appendEvent(state, ownerId, null, DEFAULT_CONVERSATION_ID, { type: 'group.changed', timestamp: nowIso(), action: 'message', group });
    });
    const bots = await this.#botIndex(ownerId);
    for (const memberId of group.memberIds.slice(0, 16)) {
      const bot = bots.get(memberId);
      if (!bot) {
        await this.store.update((state) => {
          this.#appendEvent(state, ownerId, null, DEFAULT_CONVERSATION_ID, { type: 'group.changed', timestamp: nowIso(), action: `turnFailed:${memberId}`, group });
        });
        continue;
      }
      await this.#acceptBackgroundTurn(ownerId, {
        requestId: `${command.requestId}:group:${memberId}`,
        agentId: memberId,
        agentName: bot.name,
        text: `Group "${group.name}" message from user: ${text}`,
        source: `group:${groupId}`,
        groupId,
      });
    }
    return { requestId: command.requestId };
  }

  async #executeRun(runId) {
    if (this.executing.has(runId)) return;
    this.executing.add(runId);
    const controller = new AbortController();
    this.abortControllers.set(runId, controller);
    let recoveryNotified = false;
    try {
      const maxAttempts = Math.max(1, Number(process.env.FABUSHI_HOST_RECOVERY_ATTEMPTS || 10));
      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const snapshot = await this.store.read();
        const run = snapshot.runs[runId];
        if (!run || TERMINAL_RUN_STATES.has(run.state) || run.cancelled) return;
        if (controller.signal.aborted) return;
        try {
          const response = await fetch(`${this.hostUrl}/v1/turn`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(this.internalToken ? { authorization: `Bearer ${this.internalToken}` } : {}) },
            body: JSON.stringify({ runId: run.runId, executionKey: run.executionKey, ownerId: run.ownerId, conversationId: run.conversationId, agentId: run.agentId, text: run.text, model: run.model }),
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            const body = await response.json().catch(() => ({}));
            const failure = body?.error || {};
            const error = new ProtocolError(
              typeof failure.code === 'string' && failure.code ? failure.code : 'HOST_UNAVAILABLE',
              typeof failure.message === 'string' && failure.message ? failure.message : `Host returned HTTP ${response.status}`,
              failure.details,
            );
            if (response.status >= 500 || [408,425,429].includes(response.status)) error.code = error.code || 'HOST_UNAVAILABLE';
            throw error;
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = '';
          let fallbackIndex = 0;
          const acceptLine = async (line) => {
            if (!line) return;
            const event = JSON.parse(line);
            const protocolError = hostProtocolError(event);
            if (protocolError) throw protocolError;
            fallbackIndex += 1;
            await this.#acceptHostEvent(runId, hostEventSequence(event, fallbackIndex), event);
          };
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, newline).trim();
              pending = pending.slice(newline + 1);
              await acceptLine(line);
            }
          }
          if (pending.trim()) await acceptLine(pending.trim());

          const after = await this.store.read();
          const settled = after.runs[runId];
          if (!settled || TERMINAL_RUN_STATES.has(settled.state) || settled.cancelled) return;
          throw new ProtocolError('HOST_STREAM_INCOMPLETE', 'Host stream ended before the durable run reached a terminal state');
        } catch (error) {
          if (controller.signal.aborted) return;
          lastError = error;
          if (!recoverableHostError(error) || attempt === maxAttempts) throw error;
          if (!recoveryNotified) {
            recoveryNotified = true;
            await this.store.update((state) => {
              const target = state.runs[runId];
              if (!target || TERMINAL_RUN_STATES.has(target.state) || target.cancelled) return;
              target.state = 'recovering';
              target.updatedAt = nowIso();
              target.currentStep = { stepId: 'recovering-host', kind: 'recovering', title: 'Recovering Host connection', status: 'running' };
              this.#appendEvent(state, target.ownerId, target.runId, target.conversationId, {
                type: 'agent.step',
                operationId: target.runId,
                stepId: 'recovering-host',
                kind: 'recovering',
                title: 'Recovering Host connection',
                detail: error instanceof Error ? error.message : String(error),
                status: 'running',
                timestamp: nowIso(),
              });
            });
          }
          await delayWithSignal(Math.min(1500, 100 * 2 ** (attempt - 1)), controller.signal);
        }
      }
      if (lastError) throw lastError;
    } catch (error) {
      let groupFailure = null;
      await this.store.update((state) => {
        const run = state.runs[runId];
        if (!run || TERMINAL_RUN_STATES.has(run.state) || run.cancelled) return;
        run.state = 'failed';
        run.error = errorEnvelope(error);
        run.updatedAt = nowIso();
        run.completedAt = nowIso();
        delete run.currentStep;
        if (run.background) {
          this.#appendEvent(state, run.ownerId, run.runId, run.conversationId, {
            type: 'agent.backgroundFinished',
            timestamp: nowIso(),
            agentId: run.agentId,
            agentName: run.background.agentName,
            operationId: run.runId,
            source: run.background.source,
            error: run.error.message,
          });
          if (run.background.groupId) groupFailure = { ownerId: run.ownerId, groupId: run.background.groupId, memberId: run.agentId };
        } else {
          this.#appendEvent(state, run.ownerId, run.runId, run.conversationId, { type: 'operation.failed', operationId: run.runId, code: run.error.code, message: run.error.message, timestamp: nowIso() });
        }
      });
      if (groupFailure) await this.#emitGroupFailure(groupFailure.ownerId, groupFailure.groupId, groupFailure.memberId);
    } finally {
      if (this.abortControllers.get(runId) === controller) this.abortControllers.delete(runId);
      this.executing.delete(runId);
    }
  }
  async #acceptHostEvent(runId, hostIndex, event) {
    let groupMessage = null;
    let groupFailure = null;
    await this.store.update((state) => {
      const run = state.runs[runId];
      if (!run || run.cancelled || TERMINAL_RUN_STATES.has(run.state)) return;
      if (hostIndex <= (run.hostEventIndex || 0)) return;
      run.hostEventIndex = hostIndex;
      run.state = eventRunState(event, run.state);
      run.updatedAt = nowIso();
      if (event.type === 'agent.step') {
        if (event.status === 'running') {
          run.currentStep = {
            stepId: String(event.stepId || event.kind || 'active'),
            kind: String(event.kind || 'active'),
            title: String(event.title || 'Running'),
            ...(event.detail !== undefined ? { detail: String(event.detail) } : {}),
            status: 'running',
          };
        } else if (run.currentStep?.stepId === event.stepId) {
          delete run.currentStep;
        }
      }
      if (TERMINAL_RUN_STATES.has(run.state)) {
        run.completedAt = nowIso();
        delete run.currentStep;
      }
      if (event.type === 'operation.interrupted') run.cancelled = true;
      if (event.type === 'operation.failed') run.error = { code: event.code, message: event.message };
      if (event.type === 'chat.message') {
        const conversation = ownerConversations(state, run.ownerId, true)[run.conversationId];
        if (conversation) {
          const messageId = `${run.runId}:${hostIndex}`;
          if (!conversation.messages.some((message) => message.id === messageId)) {
            conversation.messages.push({ id: messageId, role: event.role === 'user' ? 'user' : 'assistant', text: String(event.text || ''), createdAtMs: Date.now(), runId: run.runId });
            conversation.updatedAtMs = Date.now();
          }
        }
      }

      const background = run.background;
      if (!background) {
        this.#appendEvent(state, run.ownerId, run.runId, run.conversationId, event);
        return;
      }

      if (event.type === 'chat.delta') {
        this.#appendEvent(state, run.ownerId, run.runId, run.conversationId, {
          type: 'agent.backgroundDelta',
          timestamp: event.timestamp || nowIso(),
          agentId: run.agentId,
          agentName: background.agentName,
          operationId: run.runId,
          source: background.source,
          delta: String(event.delta || ''),
        });
        if (background.groupId) {
          this.#appendEvent(state, run.ownerId, run.runId, run.conversationId, {
            type: 'group.delta',
            timestamp: event.timestamp || nowIso(),
            groupId: background.groupId,
            memberId: run.agentId,
            memberName: background.agentName,
            operationId: run.runId,
            delta: String(event.delta || ''),
          });
        }
        return;
      }

      if (event.type === 'chat.message' && event.role === 'assistant') {
        const text = String(event.text || '');
        this.#appendEvent(state, run.ownerId, run.runId, run.conversationId, {
          type: 'agent.backgroundMessage',
          timestamp: event.timestamp || nowIso(),
          agentId: run.agentId,
          agentName: background.agentName,
          operationId: run.runId,
          source: background.source,
          text,
        });
        if (background.peerReplyTo) {
          const reply = {
            id: `peer-${randomUUID()}`,
            fromAgentId: run.agentId,
            fromAgentName: background.agentName,
            targetId: background.peerReplyTo.id,
            targetName: background.peerReplyTo.name,
            text,
            priority: false,
            createdAtMs: Date.now(),
          };
          appendPeerMessage(state, run.ownerId, reply);
          this.#appendEvent(state, run.ownerId, run.runId, run.conversationId, { type: 'agent.peerMessage', timestamp: nowIso(), message: reply });
        }
        if (background.groupId) groupMessage = { ownerId: run.ownerId, groupId: background.groupId, memberId: run.agentId, memberName: background.agentName, text };
        return;
      }

      if (event.type === 'operation.completed') {
        this.#appendEvent(state, run.ownerId, run.runId, run.conversationId, {
          type: 'agent.backgroundFinished',
          timestamp: event.timestamp || nowIso(),
          agentId: run.agentId,
          agentName: background.agentName,
          operationId: run.runId,
          source: background.source,
        });
        return;
      }

      if (event.type === 'operation.failed') {
        this.#appendEvent(state, run.ownerId, run.runId, run.conversationId, {
          type: 'agent.backgroundFinished',
          timestamp: event.timestamp || nowIso(),
          agentId: run.agentId,
          agentName: background.agentName,
          operationId: run.runId,
          source: background.source,
          error: String(event.message || 'Agent background run failed'),
        });
        if (background.groupId) groupFailure = { ownerId: run.ownerId, groupId: background.groupId, memberId: run.agentId };
        return;
      }

      if (event.type === 'operation.interrupted') {
        this.#appendEvent(state, run.ownerId, run.runId, run.conversationId, {
          type: 'agent.backgroundFinished',
          timestamp: event.timestamp || nowIso(),
          agentId: run.agentId,
          agentName: background.agentName,
          operationId: run.runId,
          source: background.source,
          error: 'cancelled',
        });
        return;
      }

      if (event.type !== 'operation.started' && !(event.type === 'chat.message' && event.role === 'user')) {
        this.#appendEvent(state, run.ownerId, run.runId, run.conversationId, event);
      }
    });

    if (groupMessage) {
      const group = await this.productRequest(groupMessage.ownerId, 'state.group.appendMessage', {
        id: groupMessage.groupId,
        speaker: { kind: 'member', id: groupMessage.memberId, name: groupMessage.memberName },
        content: groupMessage.text,
      });
      await this.store.update((state) => {
        this.#appendEvent(state, groupMessage.ownerId, runId, DEFAULT_CONVERSATION_ID, { type: 'group.changed', timestamp: nowIso(), action: 'message', group });
      });
    }
    if (groupFailure) await this.#emitGroupFailure(groupFailure.ownerId, groupFailure.groupId, groupFailure.memberId);
  }

  async #emitGroupFailure(ownerId, groupId, memberId) {
    try {
      const group = await this.productRequest(ownerId, 'state.group.get', { id: groupId });
      await this.store.update((state) => {
        this.#appendEvent(state, ownerId, null, DEFAULT_CONVERSATION_ID, { type: 'group.changed', timestamp: nowIso(), action: `turnFailed:${memberId}`, group });
      });
    } catch {
      // The group may have been deleted while the background run was active.
    }
  }

  async productRequest(ownerId, method, args = {}) {
    const response = await fetch(`${this.hostUrl}/v1/product`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.internalToken ? { authorization: `Bearer ${this.internalToken}` } : {}),
      },
      body: JSON.stringify({ ownerId, method, args }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok !== true) {
      const error = body?.error || {};
      throw new ProtocolError(error.code || 'HOST_PRODUCT_FAILED', error.message || `Host product request failed with HTTP ${response.status}`, error.details);
    }
    return body.result;
  }

  async #executeProductCommand(ownerId, command) {
    const response = await fetch(`${this.hostUrl}/v1/product`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.internalToken ? { authorization: `Bearer ${this.internalToken}` } : {}),
      },
      body: JSON.stringify({ ownerId, command }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok !== true || !Array.isArray(body.events)) {
      const error = body?.error || {};
      throw new ProtocolError(error.code || 'HOST_PRODUCT_FAILED', error.message || `Host product command failed with HTTP ${response.status}`, error.details);
    }
    await this.store.update((state) => {
      for (const event of body.events) {
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') continue;
        this.#appendEvent(state, ownerId, null, DEFAULT_CONVERSATION_ID, event);
      }
    });
    return { requestId: command.requestId };
  }

  async #requestCapabilityApproval(ownerId, command) {
    const approvalId = randomUUID();
    await this.store.update((state) => {
      state.approvals ??= {};
      state.approvals[approvalId] = {
        approvalId,
        ownerId,
        miniAppId: requireString(command.miniAppId, 'miniAppId', { max: 256 }),
        capability: requireString(command.capability, 'capability', { max: 256 }),
        reason: requireString(command.reason, 'reason', { max: 4096 }),
        status: 'pending',
        createdAt: nowIso(),
        resolvedAt: null,
        decision: null,
      };
      this.#appendEvent(state, ownerId, null, DEFAULT_CONVERSATION_ID, {
        type: 'approval.requested',
        timestamp: nowIso(),
        approvalId,
        miniAppId: command.miniAppId,
        capability: command.capability,
        reason: command.reason,
        kind: 'capability',
        location: 'cloud',
      });
    });
    return { requestId: command.requestId };
  }

  async resolveApproval(ownerId, input) {
    const approvalId = requireString(input?.approvalId, 'approvalId', { max: 128 });
    const decision = requireString(input?.decision, 'decision', { max: 32 });
    if (!['allow-once', 'allow-session', 'deny'].includes(decision)) {
      throw new ProtocolError('INVALID_ARGUMENT', `Unsupported approval decision: ${decision}`);
    }
    let resolved = false;
    await this.store.update((state) => {
      state.approvals ??= {};
      const approval = state.approvals[approvalId];
      if (!approval || approval.ownerId !== ownerId) return;
      if (approval.status !== 'pending') {
        if (approval.decision === decision) { resolved = true; return; }
        throw new ProtocolError('APPROVAL_ALREADY_RESOLVED', 'Approval was already resolved with a different decision');
      }
      approval.status = 'resolved';
      approval.decision = decision;
      approval.resolvedAt = nowIso();
      resolved = true;
      this.#appendEvent(state, ownerId, null, DEFAULT_CONVERSATION_ID, {
        type: 'approval.resolved',
        timestamp: nowIso(),
        approvalId,
        decision,
      });
    });
    if (!resolved) throw new ProtocolError('APPROVAL_NOT_FOUND', 'Approval not found');
    return { approvalId, decision };
  }

  async interrupt(ownerId, runId) {
    const snapshot = await this.store.read();
    const run = snapshot.runs[runId];
    if (!run || run.ownerId !== ownerId) throw new ProtocolError('NOT_FOUND', 'Run not found');
    if (TERMINAL_RUN_STATES.has(run.state)) return { operationId: runId, state: run.state };

    const response = await fetch(`${this.hostUrl}/v1/turn/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { authorization: `Bearer ${this.internalToken}` } : {}) },
      body: JSON.stringify({ runId, executionKey: run.executionKey }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok !== true) {
      const failure = body?.error || {};
      throw new ProtocolError(failure.code || 'HOST_CANCEL_FAILED', failure.message || `Host cancellation failed with HTTP ${response.status}`, failure.details);
    }
    const hostState = body?.result?.state;
    if (hostState !== 'cancelled') return { operationId: runId, state: hostState || run.state };

    this.abortControllers.get(runId)?.abort();
    await this.store.update((state) => {
      const target = state.runs[runId];
      if (!target || target.ownerId !== ownerId || TERMINAL_RUN_STATES.has(target.state)) return;
      target.cancelled = true;
      target.state = 'cancelled';
      target.updatedAt = nowIso();
      target.completedAt = nowIso();
      delete target.currentStep;
      if (target.background) {
        this.#appendEvent(state, ownerId, runId, target.conversationId, {
          type: 'agent.backgroundFinished',
          timestamp: nowIso(),
          agentId: target.agentId,
          agentName: target.background.agentName,
          operationId: runId,
          source: target.background.source,
          error: 'cancelled',
        });
      } else {
        this.#appendEvent(state, ownerId, runId, target.conversationId, { type: 'operation.interrupted', operationId: runId, timestamp: nowIso() });
      }
    });
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
    const conversations = Object.values(ownerConversations(state, ownerId, false)).map(({ messages, ...conversation }) => ({ ...conversation, unreadCount: 0 })).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    return await this.#emit(ownerId, command, { type: 'conversation.listed', conversations });
  }
  async #emitConversationOpen(ownerId, command) {
    const state = await this.store.read();
    const conversation = ownerConversations(state, ownerId, false)[command.conversationId];
    return await this.#emit(ownerId, command, { type: 'conversation.opened', conversationId: command.conversationId, messages: conversation?.messages ?? [] });
  }
  async #searchMessages(ownerId, command) {
    const query = requireString(command.query, 'query', { max: 512 }).normalize('NFKC').toLocaleLowerCase();
    const limit = Number.isSafeInteger(command.limit) ? Math.min(Math.max(command.limit, 1), 100) : 50;
    const state = await this.store.read();
    const matches = [];
    for (const conversation of Object.values(ownerConversations(state, ownerId, false))) {
      const agentId = conversation.id.startsWith('mahayana-ai:agent:') ? conversation.id.slice('mahayana-ai:agent:'.length) || DEFAULT_AGENT_ID : DEFAULT_AGENT_ID;
      for (const message of conversation.messages || []) {
        if (!String(message.text || '').normalize('NFKC').toLocaleLowerCase().includes(query)) continue;
        matches.push({
          agentId,
          agentName: agentId === DEFAULT_AGENT_ID ? 'Mahayana' : agentId,
          conversationId: conversation.id,
          entryId: message.id,
          role: message.role === 'assistant' ? 'assistant' : 'user',
          timestampMs: Number(message.createdAtMs) || 0,
          snippet: String(message.text || '').slice(0, 400),
        });
      }
    }
    matches.sort((a, b) => b.timestampMs - a.timestampMs);
    return await this.#emit(ownerId, command, { type: 'search.messages', query: command.query, matches: matches.slice(0, limit) });
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
