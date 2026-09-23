import { createHash } from "node:crypto";
import path from "node:path";
import { AtomicJsonStore } from "../shared/atomic-json-store.mjs";
import { ProtocolError, asRecord, requireString } from "../shared/protocol.mjs";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MOBILE_SIGNAL_KINDS = new Set(["offer", "ice", "ready", "close"]);
const DESKTOP_SIGNAL_KINDS = new Set(["answer", "ice", "ready", "close"]);

function ownerKey(ownerId) {
  return createHash("sha256").update(ownerId).digest("hex").slice(0, 32);
}
function initialState() {
  return { version: 1, owners: {} };
}
function validId(value, max = 160) {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9._:-]+$/.test(value);
}
function validSecret(value) {
  return typeof value === "string" && value.length >= 16 && value.length <= 16 * 1024 && !/[\u0000-\u0020\u007F]/.test(value);
}
function validCredential(value) {
  return typeof value === "string" && value.length >= 32 && value.length <= 512 && /^[A-Za-z0-9._~-]+$/.test(value);
}
function validText(value, max = 320) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001F\u007F]/.test(value);
}
function validTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function normalizePermissions(value) {
  const record = asRecord(value);
  if (!record) return null;
  return {
    display: Boolean(record.display),
    input: Boolean(record.input),
    clipboard: Boolean(record.clipboard),
    fileTransfer: Boolean(record.fileTransfer),
    audio: Boolean(record.audio),
  };
}
function normalizeIceServers(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((candidate) => {
    const record = asRecord(candidate);
    if (!record) return [];
    const urls = Array.isArray(record.urls) ? record.urls.filter((url) => typeof url === "string").slice(0, 16) : typeof record.urls === "string" ? record.urls : null;
    if (!urls) return [];
    return [{
      urls,
      ...(typeof record.username === "string" ? { username: record.username } : {}),
      ...(typeof record.credential === "string" ? { credential: record.credential } : {}),
    }];
  });
}
async function readJsonResponse(response) {
  const advertised = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) throw new ProtocolError("REMOTE_RESPONSE_TOO_LARGE", "Remote Computer response exceeded the safety limit");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new ProtocolError("REMOTE_RESPONSE_TOO_LARGE", "Remote Computer response exceeded the safety limit");
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new ProtocolError("REMOTE_BAD_RESPONSE", "Remote Computer service returned invalid JSON"); }
}
function publicPair(record) {
  return {
    deviceId: record.deviceId,
    computerLabel: record.computerLabel,
    clientId: record.clientId,
    clientLabel: record.clientLabel,
    pairedAt: record.pairedAt,
  };
}

export class RemoteComputerService {
  constructor({
    dataDir = process.env.FABUSHI_HOST_DATA_DIR || path.resolve(".data/host"),
    platformApiBase = process.env.FABUSHI_PLATFORM_API_BASE_URL || process.env.FABUSHI_MAHAYANA_API_BASE_URL || "https://api.ombhrum.com",
  } = {}) {
    const base = new URL(platformApiBase);
    if (base.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && base.protocol === "http:")) {
      throw new ProtocolError("REMOTE_CONFIG_INVALID", "Remote Computer platform API must use HTTPS");
    }
    this.baseUrl = base.toString().replace(/\/$/, "");
    this.store = new AtomicJsonStore(path.join(dataDir, "remote-computer-state.json"), initialState);
    this.auth = new Map();
    this.controlSessions = new Map();
    this.refreshes = new Map();
  }

  async invoke(ownerId, method, args = {}) {
    requireString(ownerId, "ownerId", { max: 256 });
    switch (method) {
      case "remote.authStatus": return this.authStatus(ownerId);
      case "remote.login": return await this.login(ownerId, args.username, args.password);
      case "remote.logout": return await this.logout(ownerId);
      case "remote.listComputers": return await this.listComputers(ownerId);
      case "remote.listPaired": return await this.listPaired(ownerId);
      case "remote.pair": return await this.pair(ownerId, args.pairingCode, args.label);
      case "remote.createSession": return await this.createSession(ownerId, args.deviceId, args.clientId);
      case "remote.signal": return await this.signal(ownerId, args.sessionId, args.kind, args.payload);
      case "remote.drainSignals": return await this.drainSignals(ownerId, args.sessionId, args.afterSignalId);
      case "remote.closeSession": return await this.closeSession(ownerId, args.sessionId);
      default: throw new ProtocolError("METHOD_NOT_FOUND", `Remote Computer method is not supported: ${method}`);
    }
  }

  authStatus(ownerId) {
    const session = this.auth.get(ownerId);
    return session ? { loggedIn: true, username: session.username, userId: session.userId, deviceId: session.deviceId, accessTokenExpiresAt: session.accessTokenExpiresAt } : { loggedIn: false };
  }

  async login(ownerId, username, password) {
    const name = requireString(username, "username", { max: 320 });
    if (!validText(name, 320) || typeof password !== "string" || password.length < 1 || password.length > 4096) {
      throw new ProtocolError("INVALID_ARGUMENT", "Remote Computer credentials are invalid");
    }
    const deviceId = `fabushi-web-${ownerKey(ownerId)}`;
    const response = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username: name, password, deviceId }),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new ProtocolError("REMOTE_LOGIN_FAILED", String(payload?.message ?? payload?.error ?? `Remote login HTTP ${response.status}`));
    const session = this.#normalizeAuth(payload, name, deviceId);
    this.auth.set(ownerId, session);
    return this.authStatus(ownerId);
  }

  async logout(ownerId) {
    this.auth.delete(ownerId);
    this.refreshes.delete(ownerId);
    for (const key of [...this.controlSessions.keys()]) if (key.startsWith(`${ownerId}:`)) this.controlSessions.delete(key);
    return { loggedIn: false };
  }

  async listPaired(ownerId) {
    const state = await this.store.read();
    const owner = state.owners[ownerKey(ownerId)];
    const records = owner?.paired ?? {};
    return Object.fromEntries(Object.entries(records).map(([deviceId, record]) => [deviceId, publicPair(record)]));
  }

  async listComputers(ownerId) {
    const response = await this.#authorizedFetch(ownerId, "/v1/computers");
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new ProtocolError("REMOTE_LIST_FAILED", String(payload?.message ?? payload?.error ?? `Remote list HTTP ${response.status}`));
    const computers = Array.isArray(payload?.computers) ? payload.computers : [];
    return computers.slice(0, 256).flatMap((candidate) => {
      const record = asRecord(candidate);
      if (!record || !validId(record.deviceId, 128) || !validText(record.label, 80) || !validTimestamp(record.lastSeenAt) || !validTimestamp(record.createdAt) || typeof record.online !== "boolean") return [];
      return [{
        deviceId: record.deviceId,
        label: record.label,
        lastSeenAt: record.lastSeenAt,
        createdAt: record.createdAt,
        online: record.online,
        provider: record.provider === "rustdesk-sidecar" ? "rustdesk-sidecar" : "fabushi-webrtc",
        platform: ["windows","macos","linux","android","ios","web"].includes(record.platform) ? record.platform : "unknown",
        appVersion: typeof record.appVersion === "string" ? record.appVersion.slice(0, 80) : "",
        capabilities: Array.isArray(record.capabilities) ? record.capabilities.map(String).slice(0, 32) : [],
        activeSessionCount: Number.isSafeInteger(record.activeSessionCount) && record.activeSessionCount >= 0 ? Math.min(record.activeSessionCount, 1024) : 0,
      }];
    });
  }

  async pair(ownerId, pairingCode, label) {
    this.#requireAuth(ownerId);
    const code = requireString(pairingCode, "pairingCode", { max: 32 }).toUpperCase();
    const clientLabel = requireString(label || "我的浏览器", "label", { max: 80 });
    if (!/^[0-9A-F]{12}$/.test(code) || !validText(clientLabel, 80)) throw new ProtocolError("INVALID_ARGUMENT", "Remote pairing code or label is invalid");
    const response = await this.#authorizedFetch(ownerId, "/v1/computers/pair", { method: "POST", body: JSON.stringify({ pairingCode: code, label: clientLabel }) });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new ProtocolError("REMOTE_PAIR_FAILED", String(payload?.message ?? payload?.error ?? `Remote pair HTTP ${response.status}`));
    if (!validId(payload?.deviceId, 128) || !validId(payload?.clientId) || !validCredential(payload?.clientToken) || !validText(payload?.computerLabel, 80) || !validText(payload?.clientLabel, 80) || !validTimestamp(payload?.pairedAt)) {
      throw new ProtocolError("REMOTE_BAD_RESPONSE", "Remote pairing response is incomplete");
    }
    const record = {
      deviceId: payload.deviceId,
      clientId: payload.clientId,
      clientToken: payload.clientToken,
      computerLabel: payload.computerLabel,
      clientLabel: payload.clientLabel,
      pairedAt: payload.pairedAt,
    };
    await this.store.update((state) => {
      const key = ownerKey(ownerId);
      state.owners[key] ??= { paired: {} };
      state.owners[key].paired ??= {};
      state.owners[key].paired[record.deviceId] = record;
    });
    return publicPair(record);
  }

  async createSession(ownerId, deviceId, clientId) {
    const device = requireString(deviceId, "deviceId", { max: 128 });
    const client = requireString(clientId, "clientId", { max: 160 });
    const state = await this.store.read();
    const pairing = state.owners[ownerKey(ownerId)]?.paired?.[device];
    if (!pairing || pairing.clientId !== client || !validCredential(pairing.clientToken)) throw new ProtocolError("REMOTE_NOT_PAIRED", "Remote computer is not paired for this account");
    const response = await this.#authorizedFetch(ownerId, `/v1/computers/${encodeURIComponent(device)}/sessions`, {
      method: "POST",
      body: JSON.stringify({ clientId: client, clientToken: pairing.clientToken }),
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new ProtocolError("REMOTE_SESSION_FAILED", String(payload?.message ?? payload?.error ?? `Remote session HTTP ${response.status}`));
    const permissions = normalizePermissions(payload?.permissions);
    if (payload?.deviceId !== device || payload?.clientId !== client || !validId(payload?.sessionId) || !validCredential(payload?.mobileToken) || payload?.state !== "pending" || !validTimestamp(payload?.createdAt) || !validTimestamp(payload?.expiresAt) || !permissions) {
      throw new ProtocolError("REMOTE_BAD_RESPONSE", "Remote control session response is invalid");
    }
    const internal = {
      sessionId: payload.sessionId,
      deviceId: device,
      clientId: client,
      mobileToken: payload.mobileToken,
      createdAt: payload.createdAt,
      expiresAt: payload.expiresAt,
      permissions,
      iceServers: normalizeIceServers(payload.iceServers),
    };
    this.controlSessions.set(`${ownerId}:${internal.sessionId}`, internal);
    return { ...internal, mobileToken: undefined };
  }

  async signal(ownerId, sessionId, kind, payload) {
    const session = this.#controlSession(ownerId, sessionId);
    if (!MOBILE_SIGNAL_KINDS.has(kind)) throw new ProtocolError("INVALID_ARGUMENT", "Unsupported mobile signal kind");
    const response = await this.#authorizedFetch(ownerId, `/v1/computers/${encodeURIComponent(session.deviceId)}/signals`, {
      method: "POST",
      body: JSON.stringify({ sessionId: session.sessionId, senderRole: "mobile", clientId: session.clientId, mobileToken: session.mobileToken, kind, payload }),
    });
    const body = await readJsonResponse(response);
    if (!response.ok) throw new ProtocolError("REMOTE_SIGNAL_FAILED", String(body?.message ?? body?.error ?? `Remote signal HTTP ${response.status}`));
    return { ok: true };
  }

  async drainSignals(ownerId, sessionId, afterSignalId = 0) {
    const session = this.#controlSession(ownerId, sessionId);
    const cursor = Number.isSafeInteger(afterSignalId) && afterSignalId >= 0 ? afterSignalId : 0;
    const response = await this.#authorizedFetch(ownerId, `/v1/computers/${encodeURIComponent(session.deviceId)}/signals/drain`, {
      method: "POST",
      body: JSON.stringify({ sessionId: session.sessionId, receiverRole: "mobile", clientId: session.clientId, mobileToken: session.mobileToken, afterSignalId: cursor }),
    });
    const body = await readJsonResponse(response);
    if (!response.ok) throw new ProtocolError("REMOTE_SIGNAL_FAILED", String(body?.message ?? body?.error ?? `Remote signal HTTP ${response.status}`));
    if (body?.sessionId !== session.sessionId || !Number.isSafeInteger(body?.lastSignalId) || body.lastSignalId < 0) throw new ProtocolError("REMOTE_BAD_RESPONSE", "Remote signal drain response is invalid");
    const signals = Array.isArray(body.signals) ? body.signals.slice(0, 128).flatMap((candidate) => {
      const record = asRecord(candidate);
      if (!record || !Number.isSafeInteger(record.signalId) || record.signalId <= cursor || record.senderRole !== "desktop" || !DESKTOP_SIGNAL_KINDS.has(record.kind) || !validTimestamp(record.createdAt)) return [];
      return [{ signalId: record.signalId, senderRole: "desktop", kind: record.kind, payload: record.payload, createdAt: record.createdAt }];
    }) : [];
    return { sessionId: session.sessionId, signals, lastSignalId: body.lastSignalId };
  }

  async closeSession(ownerId, sessionId) {
    const session = this.#controlSession(ownerId, sessionId);
    try {
      const response = await this.#authorizedFetch(ownerId, `/v1/computers/${encodeURIComponent(session.deviceId)}/sessions/${encodeURIComponent(session.sessionId)}/close`, {
        method: "POST",
        body: JSON.stringify({ role: "mobile", clientId: session.clientId, mobileToken: session.mobileToken }),
      });
      const body = await readJsonResponse(response);
      if (!response.ok) throw new ProtocolError("REMOTE_CLOSE_FAILED", String(body?.message ?? body?.error ?? `Remote close HTTP ${response.status}`));
    } finally {
      this.controlSessions.delete(`${ownerId}:${session.sessionId}`);
    }
    return { closed: true };
  }

  #controlSession(ownerId, sessionId) {
    const id = requireString(sessionId, "sessionId", { max: 160 });
    const session = this.controlSessions.get(`${ownerId}:${id}`);
    if (!session) throw new ProtocolError("REMOTE_SESSION_NOT_FOUND", "Remote control session was not found");
    if (session.expiresAt <= Date.now() / 1000) {
      this.controlSessions.delete(`${ownerId}:${id}`);
      throw new ProtocolError("REMOTE_SESSION_EXPIRED", "Remote control session expired");
    }
    return session;
  }

  #normalizeAuth(payload, username, expectedDeviceId) {
    const record = asRecord(payload);
    if (!record || !validSecret(record.accessToken) || !validSecret(record.refreshToken) || !validTimestamp(record.accessTokenExpiresAt) || !validTimestamp(record.refreshTokenExpiresAt) || !validId(record.sessionId) || !validId(record.deviceId) || record.deviceId !== expectedDeviceId) {
      throw new ProtocolError("REMOTE_BAD_RESPONSE", "Remote login response is invalid");
    }
    return {
      accessToken: record.accessToken,
      refreshToken: record.refreshToken,
      accessTokenExpiresAt: record.accessTokenExpiresAt,
      refreshTokenExpiresAt: record.refreshTokenExpiresAt,
      sessionId: record.sessionId,
      deviceId: record.deviceId,
      username: validText(record.username, 320) ? record.username : username,
      userId: typeof record.userId === "number" || typeof record.userId === "string" ? record.userId : username,
    };
  }

  #requireAuth(ownerId) {
    const session = this.auth.get(ownerId);
    if (!session) throw new ProtocolError("REMOTE_AUTH_REQUIRED", "Remote Computer login is required");
    return session;
  }

  async #refresh(ownerId) {
    const existing = this.refreshes.get(ownerId);
    if (existing) return await existing;
    const work = (async () => {
      const current = this.#requireAuth(ownerId);
      const response = await fetch(`${this.baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ refreshToken: current.refreshToken, deviceId: current.deviceId }),
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw new ProtocolError("REMOTE_REFRESH_FAILED", String(payload?.message ?? payload?.error ?? `Remote refresh HTTP ${response.status}`));
      const refreshed = this.#normalizeAuth(payload, current.username, current.deviceId);
      if (String(refreshed.userId) !== String(current.userId)) throw new ProtocolError("REMOTE_ACCOUNT_CHANGED", "Remote refresh returned a different account");
      this.auth.set(ownerId, refreshed);
    })().finally(() => this.refreshes.delete(ownerId));
    this.refreshes.set(ownerId, work);
    return await work;
  }

  async #authorizedFetch(ownerId, apiPath, init = {}, retried = false) {
    if (!apiPath.startsWith("/") || apiPath.startsWith("//")) throw new ProtocolError("INVALID_ARGUMENT", "Remote API path is invalid");
    const session = this.#requireAuth(ownerId);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${session.accessToken}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(`${this.baseUrl}${apiPath}`, { ...init, headers, signal: AbortSignal.timeout(20_000), redirect: "error" });
    if (response.status !== 401 || retried) return response;
    await this.#refresh(ownerId);
    return await this.#authorizedFetch(ownerId, apiPath, init, true);
  }
}
