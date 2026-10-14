import { ProtocolError, asRecord, requireString } from "../shared/protocol.mjs";

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SERVERS = 64;

function configuredServers() {
  const raw = process.env.FABUSHI_MCP_SERVERS_JSON?.trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError("MCP_CONFIG_INVALID", "FABUSHI_MCP_SERVERS_JSON is not valid JSON");
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : Object.entries(asRecord(parsed) ?? {}).map(([id, value]) => ({ id, ...(asRecord(value) ?? {}) }));
  return entries.slice(0, MAX_SERVERS).map((entry) => normalizeServer(entry));
}

function normalizeServer(value) {
  const record = asRecord(value);
  if (!record) throw new ProtocolError("MCP_CONFIG_INVALID", "MCP server entry must be an object");
  const id = requireString(record.id ?? record.name, "mcp.server.id", { max: 128 });
  const urlText = requireString(record.url, `mcp.server.${id}.url`, { max: 2048 });
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new ProtocolError("MCP_CONFIG_INVALID", `MCP server ${id} URL is invalid`);
  }
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) {
    throw new ProtocolError("MCP_CONFIG_INVALID", `MCP server ${id} must use HTTPS`);
  }
  const headers = {};
  const rawHeaders = asRecord(record.headers);
  if (rawHeaders) {
    for (const [name, headerValue] of Object.entries(rawHeaders)) {
      if (!/^[A-Za-z0-9-]{1,80}$/.test(name) || typeof headerValue !== "string" || headerValue.length > 8192) {
        throw new ProtocolError("MCP_CONFIG_INVALID", `MCP server ${id} has an invalid header`);
      }
      headers[name] = headerValue;
    }
  }
  return {
    id,
    name: typeof record.name === "string" && record.name.trim() ? record.name.trim().slice(0, 128) : id,
    url: url.toString(),
    headers,
    protocolVersion: typeof record.protocolVersion === "string" && record.protocolVersion.trim()
      ? record.protocolVersion.trim().slice(0, 32)
      : DEFAULT_PROTOCOL_VERSION,
    oauthAuthorizationUrl: typeof record.oauthAuthorizationUrl === "string" ? record.oauthAuthorizationUrl.trim() : "",
    oauthLogoutUrl: typeof record.oauthLogoutUrl === "string" ? record.oauthLogoutUrl.trim() : "",
  };
}

async function limitedText(response) {
  const advertised = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) {
    throw new ProtocolError("MCP_RESPONSE_TOO_LARGE", "MCP response exceeded the configured limit");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new ProtocolError("MCP_RESPONSE_TOO_LARGE", "MCP response exceeded the configured limit");
  }
  return text;
}

function parseRpcPayload(text, contentType) {
  if (!text.trim()) return null;
  if (contentType.includes("text/event-stream")) {
    const messages = [];
    let dataLines = [];
    const flush = () => {
      if (!dataLines.length) return;
      const payload = dataLines.join("\n").trim();
      dataLines = [];
      if (!payload || payload === "[DONE]") return;
      try { messages.push(JSON.parse(payload)); } catch { /* ignore comments/non-json events */ }
    };
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) { flush(); continue; }
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    flush();
    return messages.length === 1 ? messages[0] : messages;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("MCP_BAD_RESPONSE", "MCP server returned invalid JSON");
  }
}

function pickRpcMessage(payload, id) {
  const candidates = Array.isArray(payload) ? payload : [payload];
  return candidates.find((candidate) => asRecord(candidate)?.id === id) ?? candidates.find((candidate) => asRecord(candidate)?.error) ?? null;
}

export class McpClientPool {
  constructor() {
    this.config = new Map(configuredServers().map((server) => [server.id, server]));
    this.sessions = new Map();
    this.sequence = 0;
  }

  listConfigured() {
    return [...this.config.values()].map(({ headers: _headers, ...server }) => server);
  }

  clear(serverId) {
    if (serverId) this.sessions.delete(serverId);
    else this.sessions.clear();
  }

  server(serverId) {
    const id = requireString(serverId, "server", { max: 128 });
    const server = this.config.get(id);
    if (!server) throw new ProtocolError("MCP_SERVER_NOT_CONFIGURED", `MCP server is not configured: ${id}`);
    return server;
  }

  async listTools(serverId) {
    const result = await this.call(serverId, "tools/list", {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(serverId, tool, args = {}) {
    const name = requireString(tool, "tool", { max: 256 });
    return await this.call(serverId, "tools/call", {
      name,
      arguments: asRecord(args) ?? {},
    });
  }

  async call(serverId, method, params = {}) {
    const server = this.server(serverId);
    const session = await this.#ensureSession(server);
    const id = ++this.sequence;
    return await this.#rpc(server, session, { jsonrpc: "2.0", id, method, params });
  }

  async oauthLogout(serverId) {
    const server = this.server(serverId);
    if (!server.oauthLogoutUrl) {
      throw new ProtocolError("MCP_OAUTH_NOT_CONFIGURED", `MCP server ${server.id} has no OAuth logout endpoint`);
    }
    const url = new URL(server.oauthLogoutUrl);
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) {
      throw new ProtocolError("MCP_CONFIG_INVALID", "MCP OAuth logout endpoint must use HTTPS");
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", ...server.headers },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (!response.ok) throw new ProtocolError("MCP_OAUTH_LOGOUT_FAILED", `MCP OAuth logout failed with HTTP ${response.status}`);
    this.clear(server.id);
  }

  async #ensureSession(server) {
    const existing = this.sessions.get(server.id);
    if (existing) return existing;
    const id = ++this.sequence;
    const result = await this.#rpc(server, { protocolVersion: server.protocolVersion, sessionId: "" }, {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: server.protocolVersion,
        capabilities: {},
        clientInfo: { name: "fabushi-web-host", version: "1" },
      },
    }, true);
    const negotiated = typeof result?.protocolVersion === "string" ? result.protocolVersion : server.protocolVersion;
    const session = this.sessions.get(server.id) ?? { sessionId: "", protocolVersion: negotiated };
    session.protocolVersion = negotiated;
    this.sessions.set(server.id, session);
    await this.#post(server, session, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }, false);
    return session;
  }

  async #rpc(server, session, payload, captureSession = false) {
    const response = await this.#post(server, session, payload, true, captureSession);
    const message = pickRpcMessage(response.payload, payload.id);
    const record = asRecord(message);
    if (!record) throw new ProtocolError("MCP_BAD_RESPONSE", `MCP server ${server.id} did not return a JSON-RPC response`);
    if (record.error) {
      const error = asRecord(record.error);
      throw new ProtocolError("MCP_REMOTE_ERROR", String(error?.message ?? "MCP server error"), error);
    }
    if (!Object.prototype.hasOwnProperty.call(record, "result")) {
      throw new ProtocolError("MCP_BAD_RESPONSE", `MCP server ${server.id} response has no result`);
    }
    return record.result;
  }

  async #post(server, session, payload, expectResponse, captureSession = false) {
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": session.protocolVersion || server.protocolVersion,
      ...server.headers,
    };
    if (session.sessionId) headers["mcp-session-id"] = session.sessionId;
    const response = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (captureSession) {
      const received = response.headers.get("mcp-session-id");
      if (received && received.length <= 512) {
        session.sessionId = received;
        this.sessions.set(server.id, session);
      }
    }
    const text = await limitedText(response);
    if (!response.ok) {
      throw new ProtocolError("MCP_HTTP_ERROR", `MCP server ${server.id} returned HTTP ${response.status}`, {
        status: response.status,
        body: text.slice(0, 2000),
      });
    }
    if (!expectResponse) return { payload: null };
    return { payload: parseRpcPayload(text, response.headers.get("content-type") || "") };
  }
}
