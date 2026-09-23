import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { AtomicJsonStore } from "../shared/atomic-json-store.mjs";
import { ProtocolError, nowIso, requireString } from "../shared/protocol.mjs";

function ownerKey(ownerId) {
  return createHash("sha256").update(ownerId).digest("hex").slice(0, 32);
}
function defaultSettings() {
  return {
    notifications: true,
    autoUpdateWhenIdle: true,
    localExecution: false,
    routeEgressLocally: false,
    securityKeys: true,
    webauthnProxyEnabled: true,
    localToolPermission: "ask",
    remoteControlEnabled: true,
    aiComputerControlEnabled: true,
    autoReviewRules: [],
    inferenceProvider: "fabushi",
    sandboxRuntime: "host",
  };
}
function assistantBot() {
  return {
    id: "assistant",
    name: "Mahayana",
    description: "Durable Fabushi Web agent",
    title: "Mahayana",
    hidden: false,
    notificationsEnabled: true,
    notifyOnUpdates: true,
    unread: false,
    conversationId: "mahayana-ai:agent:assistant",
  };
}
function initialState() {
  return { version: 1, owners: {} };
}
function cleanText(value, name, max, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (text.length > max) throw new ProtocolError("INVALID_ARGUMENT", `${name} is too long`);
  return text;
}
function listIds(value, name, limit = 64) {
  if (!Array.isArray(value)) throw new ProtocolError("INVALID_ARGUMENT", `${name} must be an array`);
  const result = [];
  for (const item of value) {
    const id = requireString(item, name, { max: 256 });
    if (!result.includes(id)) result.push(id);
    if (result.length > limit) throw new ProtocolError("INVALID_ARGUMENT", `${name} contains too many values`);
  }
  return result;
}
function normalizeSettings(input, current) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const next = { ...current };
  for (const key of ["notifications","autoUpdateWhenIdle","localExecution","routeEgressLocally","securityKeys","webauthnProxyEnabled","remoteControlEnabled","aiComputerControlEnabled"]) {
    if (typeof value[key] === "boolean") next[key] = value[key];
  }
  if (["never","ask","always"].includes(value.localToolPermission)) next.localToolPermission = value.localToolPermission;
  if (["fabushi","codex","claude-code","openrouter"].includes(value.inferenceProvider)) next.inferenceProvider = value.inferenceProvider;
  if (["host","local-docker"].includes(value.sandboxRuntime)) next.sandboxRuntime = value.sandboxRuntime;
  if (Array.isArray(value.autoReviewRules)) {
    next.autoReviewRules = value.autoReviewRules.slice(0, 128).flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const behavior = candidate.behavior === "allow" ? "allow" : candidate.behavior === "ask" ? "ask" : null;
      const text = typeof candidate.text === "string" ? candidate.text.trim().slice(0, 1000) : "";
      if (!behavior || !text) return [];
      return [{ id: typeof candidate.id === "string" && candidate.id ? candidate.id.slice(0, 160) : randomUUID(), behavior, text }];
    });
  }
  return next;
}

export class StatefulProductService {
  constructor({ dataDir = process.env.FABUSHI_HOST_DATA_DIR || path.resolve(".data/host") } = {}) {
    this.store = new AtomicJsonStore(path.join(dataDir, "stateful-product.json"), initialState);
  }

  async invoke(ownerId, method, args = {}) {
    switch (method) {
      case "state.bot.list": {
        const owner = await this.#owner(ownerId);
        return Object.values(owner.bots);
      }
      case "state.group.get": {
        const owner = await this.#owner(ownerId);
        const id = requireString(args.id, "group.id", { max: 256 });
        const group = owner.groups[id];
        if (!group) throw new ProtocolError("GROUP_NOT_FOUND", "Group not found");
        return group;
      }
      case "state.group.appendMessage": {
        const id = requireString(args.id, "group.id", { max: 256 });
        const content = requireString(args.content, "group.message", { max: 120_000 });
        const speaker = args.speaker && typeof args.speaker === "object" && !Array.isArray(args.speaker) ? args.speaker : null;
        if (!speaker || (speaker.kind !== "user" && speaker.kind !== "member")) throw new ProtocolError("INVALID_ARGUMENT", "Group speaker is invalid");
        let group;
        await this.store.update((state) => {
          const owner = this.#ensureOwner(state, ownerId);
          const current = owner.groups[id];
          if (!current) throw new ProtocolError("GROUP_NOT_FOUND", "Group not found");
          const normalizedSpeaker = speaker.kind === "user"
            ? { kind: "user", ...(typeof speaker.name === "string" && speaker.name.trim() ? { name: speaker.name.trim().slice(0, 120) } : {}) }
            : { kind: "member", id: requireString(speaker.id, "group.member.id", { max: 256 }), name: requireString(speaker.name, "group.member.name", { max: 160 }) };
          current.messages.push({ id: `group-message-${randomUUID()}`, speaker: normalizedSpeaker, content, createdAtMs: Date.now() });
          if (current.messages.length > 2000) current.messages.splice(0, current.messages.length - 2000);
          current.updatedAtMs = Date.now();
          group = structuredClone(current);
        });
        return group;
      }
      default:
        throw new ProtocolError("METHOD_NOT_FOUND", `Stateful product method is not supported: ${method}`);
    }
  }

  async runtimeCommand(ownerId, command) {
    switch (command.type) {
      case "settings.get": return await this.settingsGet(ownerId);
      case "settings.update": return await this.settingsUpdate(ownerId, command);
      case "bot.list": return await this.botList(ownerId);
      case "bot.create": return await this.botCreate(ownerId, command);
      case "bot.update": return await this.botUpdate(ownerId, command);
      case "bot.clone": return await this.botClone(ownerId, command);
      case "bot.delete": return await this.botDelete(ownerId, command);
      case "bot.setHidden": return await this.botSetHidden(ownerId, command);
      case "group.list": return await this.groupList(ownerId);
      case "group.create": return await this.groupCreate(ownerId, command);
      case "group.update": return await this.groupUpdate(ownerId, command);
      case "group.delete": return await this.groupDelete(ownerId, command);
      case "skill.list": return await this.skillList(ownerId, command);
      case "skill.upsert": return await this.skillUpsert(ownerId, command);
      case "skill.delete": return await this.skillDelete(ownerId, command);
      case "memory.list": return await this.memoryList(ownerId, command);
      case "memory.add": return await this.memoryAdd(ownerId, command);
      case "memory.remove": return await this.memoryRemove(ownerId, command);
      case "memory.clear": return await this.memoryClear(ownerId, command);
      case "tray.list": return await this.trayList(ownerId);
      case "tray.dismiss": return await this.trayDismiss(ownerId, command);
      case "tray.clear": return await this.trayClear(ownerId);
      case "tray.clearForAgent": return await this.trayClearForAgent(ownerId, command);
      default: throw new ProtocolError("COMMAND_NOT_IMPLEMENTED", `Stateful product command is not supported: ${command.type}`);
    }
  }

  async settingsGet(ownerId) {
    const owner = await this.#owner(ownerId);
    return [{ type: "settings.changed", timestamp: nowIso(), settings: owner.settings }];
  }
  async settingsUpdate(ownerId, command) {
    let settings;
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      owner.settings = normalizeSettings(command.settings, owner.settings);
      settings = structuredClone(owner.settings);
    });
    return [{ type: "settings.changed", timestamp: nowIso(), settings }];
  }

  async botList(ownerId) {
    const owner = await this.#owner(ownerId);
    return [{ type: "bot.listed", timestamp: nowIso(), bots: Object.values(owner.bots) }];
  }
  async botCreate(ownerId, command) {
    const now = Date.now();
    const id = `agent-${randomUUID()}`;
    const bot = {
      id,
      name: requireString(command.name, "bot.name", { max: 120 }),
      description: cleanText(command.description, "bot.description", 2000),
      title: cleanText(command.title, "bot.title", 160, command.name),
      hidden: false,
      ...(command.avatar ? { avatar: cleanText(command.avatar, "bot.avatar", 2000) } : {}),
      ...(command.avatarShape ? { avatarShape: cleanText(command.avatarShape, "bot.avatarShape", 80) } : {}),
      ...(command.avatarColor ? { avatarColor: cleanText(command.avatarColor, "bot.avatarColor", 80) } : {}),
      notificationsEnabled: true,
      notifyOnUpdates: true,
      unread: false,
      conversationId: `mahayana-ai:agent:${id}`,
      createdAtMs: now,
    };
    await this.store.update((state) => { this.#ensureOwner(state, ownerId).bots[id] = bot; });
    return [{ type: "bot.changed", timestamp: nowIso(), action: "created", bot }];
  }
  async botUpdate(ownerId, command) {
    let bot;
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      const current = owner.bots[requireString(command.id, "bot.id", { max: 256 })];
      if (!current) throw new ProtocolError("BOT_NOT_FOUND", "Agent not found");
      const next = { ...current };
      if (command.name !== undefined) next.name = requireString(command.name, "bot.name", { max: 120 });
      if (command.description !== undefined) next.description = cleanText(command.description, "bot.description", 2000);
      if (command.title !== undefined) next.title = cleanText(command.title, "bot.title", 160);
      if (command.avatar !== undefined) next.avatar = cleanText(command.avatar, "bot.avatar", 2000);
      if (command.avatarShape !== undefined) next.avatarShape = cleanText(command.avatarShape, "bot.avatarShape", 80);
      if (command.avatarColor !== undefined) next.avatarColor = cleanText(command.avatarColor, "bot.avatarColor", 80);
      for (const key of ["notificationsEnabled","notifyOnUpdates","unread","hidden"]) if (typeof command[key] === "boolean") next[key] = command[key];
      owner.bots[next.id] = next;
      bot = structuredClone(next);
    });
    return [{ type: "bot.changed", timestamp: nowIso(), action: "updated", bot }];
  }
  async botClone(ownerId, command) {
    let bot;
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      const current = owner.bots[requireString(command.id, "bot.id", { max: 256 })];
      if (!current) throw new ProtocolError("BOT_NOT_FOUND", "Agent not found");
      const id = `agent-${randomUUID()}`;
      bot = { ...structuredClone(current), id, name: `${current.name} Copy`.slice(0, 120), hidden: false, unread: false, conversationId: `mahayana-ai:agent:${id}` };
      owner.bots[id] = bot;
    });
    return [{ type: "bot.changed", timestamp: nowIso(), action: "cloned", bot }];
  }
  async botDelete(ownerId, command) {
    let bot;
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      const id = requireString(command.id, "bot.id", { max: 256 });
      if (id === "assistant") throw new ProtocolError("BOT_PROTECTED", "The default Mahayana agent cannot be deleted");
      bot = owner.bots[id];
      if (!bot) throw new ProtocolError("BOT_NOT_FOUND", "Agent not found");
      delete owner.bots[id];
    });
    return [{ type: "bot.changed", timestamp: nowIso(), action: "deleted", bot }];
  }
  async botSetHidden(ownerId, command) {
    return await this.botUpdate(ownerId, { type: "bot.update", id: command.id, hidden: Boolean(command.hidden) });
  }

  async groupList(ownerId) {
    const owner = await this.#owner(ownerId);
    return [{ type: "group.listed", timestamp: nowIso(), groups: Object.values(owner.groups) }];
  }
  async groupCreate(ownerId, command) {
    const now = Date.now();
    const group = {
      id: `group-${randomUUID()}`,
      name: requireString(command.name, "group.name", { max: 160 }),
      description: cleanText(command.description, "group.description", 2000),
      memberIds: listIds(command.memberIds, "group.memberIds"),
      messages: [],
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.store.update((state) => { this.#ensureOwner(state, ownerId).groups[group.id] = group; });
    return [{ type: "group.changed", timestamp: nowIso(), action: "created", group }];
  }
  async groupUpdate(ownerId, command) {
    let group;
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      const current = owner.groups[requireString(command.id, "group.id", { max: 256 })];
      if (!current) throw new ProtocolError("GROUP_NOT_FOUND", "Group not found");
      if (command.name !== undefined) current.name = requireString(command.name, "group.name", { max: 160 });
      if (command.description !== undefined) current.description = cleanText(command.description, "group.description", 2000);
      if (command.memberIds !== undefined) current.memberIds = listIds(command.memberIds, "group.memberIds");
      current.updatedAtMs = Date.now();
      group = structuredClone(current);
    });
    return [{ type: "group.changed", timestamp: nowIso(), action: "updated", group }];
  }
  async groupDelete(ownerId, command) {
    let group;
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      const id = requireString(command.id, "group.id", { max: 256 });
      group = owner.groups[id];
      if (!group) throw new ProtocolError("GROUP_NOT_FOUND", "Group not found");
      delete owner.groups[id];
    });
    return [{ type: "group.changed", timestamp: nowIso(), action: "deleted", group }];
  }

  async skillList(ownerId, command) {
    const owner = await this.#owner(ownerId);
    const skills = Object.values(owner.skills).filter((skill) => !command.agentId || !skill.ownerAgentId || skill.ownerAgentId === command.agentId);
    return [{ type: "skill.listed", timestamp: nowIso(), skills, teams: [] }];
  }
  async skillUpsert(ownerId, command) {
    let skill;
    let action = "created";
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      const id = command.id ? requireString(command.id, "skill.id", { max: 256 }) : `skill-${randomUUID()}`;
      const previous = owner.skills[id];
      if (previous?.readOnly) throw new ProtocolError("SKILL_READ_ONLY", "Managed skills cannot be edited");
      action = previous ? "updated" : "created";
      skill = {
        ...(previous ?? {}),
        id,
        name: requireString(command.name, "skill.name", { max: 160 }),
        description: cleanText(command.description, "skill.description", 2000),
        useWhen: cleanText(command.useWhen, "skill.useWhen", 4000),
        instructions: cleanText(command.instructions, "skill.instructions", 80_000),
        source: previous?.source ?? "private",
        publishState: previous?.publishState ?? "local",
        ...(command.ownerAgentId ? { ownerAgentId: requireString(command.ownerAgentId, "skill.ownerAgentId", { max: 256 }) } : {}),
        updatedAtMs: Date.now(),
      };
      owner.skills[id] = skill;
    });
    return [{ type: "skill.changed", timestamp: nowIso(), action, skill }];
  }
  async skillDelete(ownerId, command) {
    let skill;
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      const id = requireString(command.id, "skill.id", { max: 256 });
      skill = owner.skills[id];
      if (!skill) throw new ProtocolError("SKILL_NOT_FOUND", "Skill not found");
      if (skill.readOnly) throw new ProtocolError("SKILL_READ_ONLY", "Managed skills cannot be deleted");
      delete owner.skills[id];
    });
    return [{ type: "skill.changed", timestamp: nowIso(), action: "deleted", skill }];
  }

  async memoryList(ownerId, command) {
    const owner = await this.#owner(ownerId);
    const agentId = requireString(command.agentId, "memory.agentId", { max: 256 });
    const limit = Number.isSafeInteger(command.limit) ? Math.min(Math.max(command.limit, 1), 500) : 200;
    const memories = Object.values(owner.memories[agentId] ?? {}).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    return [{ type: "memory.listed", timestamp: nowIso(), agentId, memories, count: memories.length, location: "host" }];
  }
  async memoryAdd(ownerId, command) {
    const agentId = requireString(command.agentId, "memory.agentId", { max: 256 });
    const kind = command.kind === "profile" ? "profile" : command.kind === "log" ? "log" : null;
    if (!kind) throw new ProtocolError("INVALID_ARGUMENT", "Memory kind is invalid");
    const memory = { id: `memory-${randomUUID()}`, content: requireString(command.content, "memory.content", { max: 20_000 }), createdAt: Date.now(), kind };
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      owner.memories[agentId] ??= {};
      owner.memories[agentId][memory.id] = memory;
    });
    return [{ type: "memory.changed", timestamp: nowIso(), agentId, action: "added", memory }];
  }
  async memoryRemove(ownerId, command) {
    const agentId = requireString(command.agentId, "memory.agentId", { max: 256 });
    const id = requireString(command.id, "memory.id", { max: 256 });
    let memory;
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      memory = owner.memories[agentId]?.[id];
      if (!memory) throw new ProtocolError("MEMORY_NOT_FOUND", "Memory not found");
      delete owner.memories[agentId][id];
    });
    return [{ type: "memory.changed", timestamp: nowIso(), agentId, action: "removed", memory }];
  }
  async memoryClear(ownerId, command) {
    const agentId = requireString(command.agentId, "memory.agentId", { max: 256 });
    await this.store.update((state) => { this.#ensureOwner(state, ownerId).memories[agentId] = {}; });
    return [{ type: "memory.changed", timestamp: nowIso(), agentId, action: "cleared" }];
  }

  async trayList(ownerId) {
    const owner = await this.#owner(ownerId);
    return [{ type: "tray.listed", timestamp: nowIso(), trays: Object.values(owner.trays).sort((a, b) => b.createdAt - a.createdAt) }];
  }
  async trayDismiss(ownerId, command) {
    const id = requireString(command.id, "tray.id", { max: 256 });
    await this.store.update((state) => { delete this.#ensureOwner(state, ownerId).trays[id]; });
    return [{ type: "tray.changed", timestamp: nowIso(), action: "dismissed", id }];
  }
  async trayClear(ownerId) {
    await this.store.update((state) => { this.#ensureOwner(state, ownerId).trays = {}; });
    return [{ type: "tray.changed", timestamp: nowIso(), action: "cleared" }];
  }
  async trayClearForAgent(ownerId, command) {
    const agentId = requireString(command.agentId, "tray.agentId", { max: 256 });
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      for (const [id, tray] of Object.entries(owner.trays)) if (tray.agentId === agentId) delete owner.trays[id];
    });
    return [{ type: "tray.changed", timestamp: nowIso(), action: "cleared" }];
  }

  async #owner(ownerId) {
    const state = await this.store.read();
    const owner = state.owners?.[ownerKey(ownerId)];
    return owner ? structuredClone(owner) : this.#newOwner();
  }
  #newOwner() {
    const assistant = assistantBot();
    return {
      settings: defaultSettings(),
      bots: { [assistant.id]: assistant },
      groups: {},
      skills: {},
      memories: {},
      trays: {},
    };
  }
  #ensureOwner(state, ownerId) {
    state.owners ??= {};
    const key = ownerKey(ownerId);
    state.owners[key] ??= this.#newOwner();
    state.owners[key].settings ??= defaultSettings();
    state.owners[key].bots ??= { assistant: assistantBot() };
    state.owners[key].bots.assistant ??= assistantBot();
    state.owners[key].groups ??= {};
    state.owners[key].skills ??= {};
    state.owners[key].memories ??= {};
    state.owners[key].trays ??= {};
    return state.owners[key];
  }
}
