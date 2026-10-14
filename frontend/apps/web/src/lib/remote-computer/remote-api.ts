import type { RemoteComputerCapability, RemoteComputerPlatform, RemoteComputerProvider } from "../mahayana-host/contracts";

export interface RemoteAuthSession {
  loggedIn: true;
  username: string;
  userId: string | number;
  deviceId: string;
  accessTokenExpiresAt: number;
}

export interface RemoteComputerInfo {
  deviceId: string;
  label: string;
  lastSeenAt: number;
  createdAt: number;
  online: boolean;
  provider: RemoteComputerProvider;
  platform: RemoteComputerPlatform;
  appVersion: string;
  capabilities: RemoteComputerCapability[];
  activeSessionCount: number;
}

export interface PairingResult {
  deviceId: string;
  computerLabel: string;
  clientId: string;
  clientLabel: string;
  pairedAt: number;
}

export interface RemoteControlPermissions {
  display: boolean;
  input: boolean;
  clipboard: boolean;
  fileTransfer: boolean;
  audio: boolean;
}

export interface MobileControlSession {
  sessionId: string;
  deviceId: string;
  clientId: string;
  createdAt: number;
  expiresAt: number;
  state: "pending" | "active" | "closed";
  iceServers: RTCIceServer[];
  permissions: RemoteControlPermissions;
}

export interface RemoteSignal {
  signalId: number;
  senderRole: "desktop" | "mobile";
  kind: "offer" | "answer" | "ice" | "ready" | "close";
  payload: unknown;
  createdAt: number;
}

export interface SignalDrain {
  sessionId: string;
  signals: RemoteSignal[];
  lastSignalId: number;
}

export interface PairedClientRecord {
  deviceId: string;
  clientId: string;
  computerLabel: string;
  clientLabel: string;
  pairedAt: number;
}

interface RpcResponse<T> {
  ok?: boolean;
  result?: T;
  error?: { code?: string; message?: string };
}

function normalizeError(body: unknown, status: number): Error {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
  const message = typeof nested.message === "string"
    ? nested.message
    : typeof record.message === "string"
      ? record.message
      : `Remote Computer request failed (HTTP ${status})`;
  return new Error(message);
}

export class RemoteComputerApi {
  private session: RemoteAuthSession | null = null;

  currentSession(): RemoteAuthSession | null {
    return this.session ? { ...this.session } : null;
  }

  async authStatus(): Promise<RemoteAuthSession | null> {
    const status = await this.rpc<{ loggedIn: boolean; username?: string; userId?: string | number; deviceId?: string; accessTokenExpiresAt?: number }>("remote.authStatus");
    if (!status.loggedIn || typeof status.username !== "string" || status.userId === undefined || typeof status.deviceId !== "string" || typeof status.accessTokenExpiresAt !== "number") {
      this.session = null;
      return null;
    }
    this.session = {
      loggedIn: true,
      username: status.username,
      userId: status.userId,
      deviceId: status.deviceId,
      accessTokenExpiresAt: status.accessTokenExpiresAt,
    };
    return { ...this.session };
  }

  async login(username: string, password: string): Promise<RemoteAuthSession> {
    const status = await this.rpc<RemoteAuthSession>("remote.login", { username, password });
    this.session = status;
    return { ...status };
  }

  async logout(): Promise<void> {
    await this.rpc("remote.logout");
    this.session = null;
  }

  async pairedClients(): Promise<Record<string, PairedClientRecord>> {
    return await this.rpc<Record<string, PairedClientRecord>>("remote.listPaired");
  }

  async listComputers(): Promise<RemoteComputerInfo[]> {
    return await this.rpc<RemoteComputerInfo[]>("remote.listComputers");
  }

  async pair(pairingCode: string, label: string): Promise<PairingResult> {
    return await this.rpc<PairingResult>("remote.pair", { pairingCode, label });
  }

  async createControlSession(deviceId: string, clientId: string): Promise<MobileControlSession> {
    return await this.rpc<MobileControlSession>("remote.createSession", { deviceId, clientId });
  }

  async signal(session: MobileControlSession, kind: RemoteSignal["kind"], payload: unknown): Promise<void> {
    await this.rpc("remote.signal", { sessionId: session.sessionId, kind, payload });
  }

  async drainSignals(session: MobileControlSession, afterSignalId: number): Promise<SignalDrain> {
    return await this.rpc<SignalDrain>("remote.drainSignals", { sessionId: session.sessionId, afterSignalId });
  }

  async closeSession(session: MobileControlSession): Promise<void> {
    await this.rpc("remote.closeSession", { sessionId: session.sessionId });
  }

  private async rpc<T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch("/v1/remote", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ method, args }),
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    });
    let body: RpcResponse<T>;
    try {
      body = await response.json() as RpcResponse<T>;
    } catch {
      throw new Error("Remote Computer gateway returned invalid JSON");
    }
    if (!response.ok || body.ok !== true) throw normalizeError(body, response.status);
    return body.result as T;
  }
}
