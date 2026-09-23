import type { ApprovalResolution, AuthProvider, AuthProviderId, AuthState, BrowserLoginAttempt, BrowserLoginPollResult, BrowserLoginReopenResult, CommandAccepted, HostConfig, HostInfo, OAuthAttempt, OAuthPollResult, RuntimeCommand, RuntimeEvent } from "./contracts";
import type { InstalledPluginList, InstalledPluginPointer, MahayanaHostTransport, MarketplaceBrowseResult, MarketplaceReleaseMetadata, PluginUiDocument, PluginUninstallResult, RuntimeEventListener } from "./transport";

const PROTOCOL_VERSION = 1;
const MAX_RECONNECT_DELAY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type ActiveRunSnapshot = {
  runId?: unknown;
  operationId?: unknown;
  state?: unknown;
  currentStep?: unknown;
  background?: unknown;
};
type ServerEnvelope =
  | { protocolVersion: 1; kind: "lifecycle"; type: "ready" | "shutdown"; highWaterMark?: number; activeRuns?: unknown[] }
  | { protocolVersion: 1; kind: "reply"; requestId: string; ok: true; result: unknown }
  | { protocolVersion: 1; kind: "reply"; requestId: string; ok: false; error?: { code?: string; message?: string } }
  | { protocolVersion: 1; kind: "event"; seq: number; event: RuntimeEvent };
function configuredGatewayUrl(): string | null {
  const configured = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_MAHAYANA_GATEWAY_URL?.trim() : undefined;
  if (!configured) return null;
  const baseUrl = typeof window !== "undefined" ? window.location.href : "http://127.0.0.1/";
  try { const url = new URL(configured, baseUrl); if (url.protocol !== "ws:" && url.protocol !== "wss:") return null; return url.toString(); } catch { return null; }
}
export function isWebSocketMahayanaHostConfigured(): boolean { return configuredGatewayUrl() !== null; }
function webHttpBase(wsUrl: string): string { const url = new URL(wsUrl); url.protocol = url.protocol === "wss:" ? "https:" : "http:"; url.pathname = "/"; url.search = ""; url.hash = ""; return url.toString().replace(/\/$/, ""); }
function asRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function activeRunEvents(value: unknown): RuntimeEvent[] {
  const run = asRecord(value) as ActiveRunSnapshot | null;
  if (!run || run.background === true) return [];
  const operationId = typeof run.operationId === "string" && run.operationId ? run.operationId : typeof run.runId === "string" && run.runId ? run.runId : "";
  if (!operationId) return [];
  const step = asRecord(run.currentStep);
  const state = typeof run.state === "string" ? run.state : "running";
  const fallbackKind = state === "tool-running" ? "tool" : state === "streaming" ? "streaming" : state === "preparing" ? "preparing" : state === "recovering" ? "recovering" : "thinking";
  const kind = typeof step?.kind === "string" && step.kind ? step.kind : fallbackKind;
  const stepId = typeof step?.stepId === "string" && step.stepId ? step.stepId : `restored:${state}`;
  const title = typeof step?.title === "string" && step.title ? step.title : state === "tool-running" ? "Tool running" : state === "streaming" ? "Streaming" : state === "recovering" ? "Recovering durable run" : "Resuming agent run";
  const detail = typeof step?.detail === "string" && step.detail ? step.detail : undefined;
  const timestamp = new Date().toISOString();
  return [
    { type: "operation.started", timestamp, operationId, label: title, interruptible: true, restored: true },
    { type: "agent.step", timestamp, operationId, stepId, kind, title, ...(detail ? { detail } : {}), status: "running" },
  ];
}

export class WebSocketMahayanaHostTransport implements MahayanaHostTransport {
  private readonly listeners = new Set<RuntimeEventListener>();
  private readonly pending = new Map<string, PendingRequest>();
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private closed = false;
  private requestSequence = 0;
  private lastSeq = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private profileId = "default";
  private info: HostInfo = { runtimeVersion: "mahayana-web-gateway", protocolVersion: "1", platform: "web" };
  constructor(private readonly gatewayUrl = configuredGatewayUrl()) { if (!gatewayUrl) throw new Error("NEXT_PUBLIC_MAHAYANA_GATEWAY_URL is not configured"); }
  subscribe(listener: RuntimeEventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async initialize(config: HostConfig): Promise<HostInfo> { this.profileId = config.profileId || "default"; this.lastSeq = this.readCursor(); this.closed = false; await this.ensureConnected(); this.emit({ type: "host.ready", timestamp: new Date().toISOString(), info: this.info }); return this.info; }
  execute(command: RuntimeCommand): Promise<CommandAccepted> { return this.rpc<CommandAccepted>("runtime.execute", { command }); }
  authStatus(): Promise<AuthState> { return this.rpc<AuthState>("auth.status", {}); }
  authProviders(): Promise<AuthProvider[]> { return this.rpc<AuthProvider[]>("auth.providers", {}); }
  browserLoginStart(): Promise<BrowserLoginAttempt> { return Promise.reject(new Error("Web login is owned by the authenticated Web Main session boundary")); }
  browserLoginPoll(_attemptId: string): Promise<BrowserLoginPollResult> { return Promise.reject(new Error("Web login polling is not used after session exchange")); }
  browserLoginCancel(_attemptId: string): Promise<BrowserLoginPollResult> { return Promise.reject(new Error("Web login polling is not used after session exchange")); }
  browserLoginReopen(_attemptId: string): Promise<BrowserLoginReopenResult> { return Promise.reject(new Error("Web login polling is not used after session exchange")); }
  oauthStart(_provider: AuthProviderId): Promise<OAuthAttempt> { return Promise.reject(new Error("OAuth starts at the Web Main authentication boundary")); }
  oauthPoll(_attemptId: string): Promise<OAuthPollResult> { return Promise.reject(new Error("OAuth polling is owned by Web Main")); }
  async openExternal(url: string): Promise<void> { const parsed = new URL(url, window.location.href); if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Unsupported external URL protocol"); window.open(parsed.toString(), "_blank", "noopener,noreferrer"); }
  openSystemSettings(_pane: "screen-recording" | "accessibility"): Promise<void> { return Promise.reject(new Error("Native system settings are not available in a browser")); }
  windowFocused(): Promise<boolean> { return Promise.resolve(document.hasFocus()); }
  async showNotification(title: string, body: string): Promise<void> { if (!("Notification" in window)) return; if (Notification.permission === "default") await Notification.requestPermission(); if (Notification.permission === "granted") new Notification(title, { body }); }
  passwordLogin(_username: string, _password: string): Promise<AuthState> { return Promise.reject(new Error("Password credentials are never sent through the coordinator WebSocket")); }
  async logout(): Promise<AuthState> { await fetch(`${webHttpBase(this.gatewayUrl!)}/v1/auth/logout`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" }); await this.close(); return { loggedIn: false }; }
  interrupt(operationId: string): Promise<void> { return this.rpc("runtime.interrupt", { operationId }).then(() => undefined); }
  resolveApproval(resolution: ApprovalResolution): Promise<void> { return this.rpc("runtime.approval", resolution as unknown as Record<string, unknown>).then(() => undefined); }
  marketplaceBrowse(query?: string): Promise<MarketplaceBrowseResult> { return this.rpc("marketplace.browse", { query }); }
  marketplaceRelease(pluginId: string, version: string): Promise<MarketplaceReleaseMetadata> { return this.rpc("marketplace.release", { pluginId, version }); }
  pluginInstall(release: Record<string, unknown>, platform?: string): Promise<InstalledPluginPointer> { return this.rpc("plugin.install", { release, platform }); }
  pluginUninstall(pluginId: string): Promise<PluginUninstallResult> { return this.rpc("plugin.uninstall", { pluginId }); }
  pluginRollback(pluginId: string): Promise<InstalledPluginPointer | null> { return this.rpc("plugin.rollback", { pluginId }); }
  pluginActive(pluginId: string): Promise<InstalledPluginPointer | null> { return this.rpc("plugin.active", { pluginId }); }
  pluginListInstalled(): Promise<InstalledPluginList> { return this.rpc("plugin.listInstalled", {}); }
  pluginUiDocument(pluginId: string): Promise<PluginUiDocument> { return this.rpc("plugin.uiDocument", { pluginId }); }
  async close(): Promise<void> {
    this.closed = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    const socket = this.socket; this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) { socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, kind: "lifecycle", type: "shutdown" })); socket.close(1000, "transport closed"); }
    this.rejectPending(new Error("Mahayana WebSocket transport closed")); this.emit({ type: "host.closed", timestamp: new Date().toISOString() });
  }
  private async rpc<T>(method: string, args: Record<string, unknown>): Promise<T> {
    if (this.closed) throw new Error("Mahayana WebSocket transport is closed"); await this.ensureConnected();
    const socket = this.socket; if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Mahayana WebSocket is not connected");
    const requestId = `web-${Date.now().toString(36)}-${++this.requestSequence}`;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`Mahayana Web request timed out: ${method}`)); }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer }); socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, kind: "request", requestId, method, args }));
    });
  }
  private ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(); if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.gatewayUrl!); this.socket = socket; let settled = false;
      socket.addEventListener("open", () => socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, kind: "lifecycle", type: "hello", afterSeq: this.lastSeq })));
      socket.addEventListener("message", (event) => {
        try {
          const envelope = JSON.parse(String(event.data)) as ServerEnvelope; if (envelope.protocolVersion !== PROTOCOL_VERSION) throw new Error("Mahayana protocol version mismatch");
          if (envelope.kind === "lifecycle" && envelope.type === "ready") {
            this.reconnectAttempt = 0;
            for (const run of envelope.activeRuns ?? []) for (const restored of activeRunEvents(run)) this.emit(restored);
            if (!settled) { settled = true; resolve(); }
            return;
          }
          if (envelope.kind === "reply") { const pending = this.pending.get(envelope.requestId); if (!pending) return; this.pending.delete(envelope.requestId); clearTimeout(pending.timer); if (envelope.ok) pending.resolve(envelope.result); else pending.reject(new Error(envelope.error?.message || envelope.error?.code || "Mahayana request failed")); return; }
          if (envelope.kind === "event") { if (!Number.isSafeInteger(envelope.seq) || envelope.seq <= this.lastSeq) return; this.lastSeq = envelope.seq; this.writeCursor(this.lastSeq); this.emit(envelope.event); }
        } catch (error) { if (!settled) { settled = true; reject(error instanceof Error ? error : new Error(String(error))); } }
      });
      socket.addEventListener("close", () => { if (this.socket === socket) this.socket = null; this.rejectPending(new Error("Mahayana WebSocket disconnected before pending requests settled")); if (!settled) { settled = true; reject(new Error("Mahayana WebSocket closed during connection")); } if (!this.closed) this.scheduleReconnect(); });
      socket.addEventListener("error", () => { if (!settled) { settled = true; reject(new Error("Mahayana WebSocket connection failed")); } });
    }).finally(() => { this.connectPromise = null; }); return this.connectPromise;
  }
  private scheduleReconnect(): void { if (this.closed || this.reconnectTimer) return; const delay = Math.min(MAX_RECONNECT_DELAY_MS, 250 * 2 ** Math.min(this.reconnectAttempt++, 6)); this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.ensureConnected().catch(() => this.scheduleReconnect()); }, delay); }
  private rejectPending(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  private emit(event: RuntimeEvent): void { for (const listener of this.listeners) listener(event); }
  private cursorKey(): string { return `fabushi.mahayana.web.cursor.v1:${this.profileId}`; }
  private readCursor(): number { try { const value = Number(sessionStorage.getItem(this.cursorKey()) || 0); return Number.isSafeInteger(value) && value >= 0 ? value : 0; } catch { return 0; } }
  private writeCursor(value: number): void { try { sessionStorage.setItem(this.cursorKey(), String(value)); } catch {} }
}
