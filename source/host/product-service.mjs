import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { AtomicJsonStore } from "../shared/atomic-json-store.mjs";
import { ProtocolError, asRecord, nowIso, requireString } from "../shared/protocol.mjs";
import { McpClientPool } from "./mcp-client.mjs";
import { RemoteComputerService } from "./remote-computer-service.mjs";
import { AttachmentService } from "./attachment-service.mjs";

const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_UI_BYTES = 2 * 1024 * 1024;

function ownerKey(ownerId) {
  return createHash("sha256").update(ownerId).digest("hex").slice(0, 32);
}

function safeSegment(value, name) {
  const segment = requireString(value, name, { max: 160 });
  if (!/^[A-Za-z0-9._+-]+$/.test(segment) || segment === "." || segment === "..") {
    throw new ProtocolError("INVALID_ARGUMENT", `${name} contains unsupported characters`);
  }
  return segment;
}

function initialProductState() {
  return { version: 1, owners: {} };
}

function readTarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  const stop = end >= start && end < start + length ? end : start + length;
  return buffer.subarray(start, stop).toString("utf8").trim();
}

function normalizeTarPath(name) {
  const normalized = name.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) {
    throw new ProtocolError("PLUGIN_ARCHIVE_INVALID", `Unsafe plugin archive path: ${name}`);
  }
  return normalized;
}

async function extractTarGz(bytes, destination) {
  let tar;
  try {
    tar = gunzipSync(bytes);
  } catch {
    throw new ProtocolError("PLUGIN_ARCHIVE_INVALID", "Plugin artifact is not valid gzip data");
  }
  if (tar.length > MAX_ARTIFACT_BYTES * 4) {
    throw new ProtocolError("PLUGIN_ARCHIVE_TOO_LARGE", "Expanded plugin archive exceeds the safety limit");
  }
  let offset = 0;
  let files = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const rawSize = readTarString(header, 124, 12).replace(/\0/g, "").trim();
    const size = rawSize ? Number.parseInt(rawSize, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARTIFACT_BYTES) {
      throw new ProtocolError("PLUGIN_ARCHIVE_INVALID", `Invalid tar entry size for ${name}`);
    }
    const type = String.fromCharCode(header[156] || 0);
    const relative = normalizeTarPath(prefix ? `${prefix}/${name}` : name);
    const target = path.join(destination, relative);
    const relativeCheck = path.relative(destination, target);
    if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
      throw new ProtocolError("PLUGIN_ARCHIVE_INVALID", `Plugin archive escaped install root: ${relative}`);
    }
    if (type === "5") {
      await mkdir(target, { recursive: true });
    } else if (type === "\0" || type === "0") {
      files += 1;
      if (files > 2048) throw new ProtocolError("PLUGIN_ARCHIVE_INVALID", "Plugin archive contains too many files");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, tar.subarray(offset + 512, offset + 512 + size), { mode: 0o600 });
    } else if (type === "x" || type === "g") {
      // PAX metadata is ignored; the following concrete entry still receives
      // the same traversal/size checks.
    } else {
      throw new ProtocolError("PLUGIN_ARCHIVE_INVALID", `Unsupported tar entry type for ${relative}`);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!files) throw new ProtocolError("PLUGIN_ARCHIVE_INVALID", "Plugin archive did not contain files");
}

async function responseBytes(response) {
  const advertised = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(advertised) && advertised > MAX_ARTIFACT_BYTES) {
    throw new ProtocolError("PLUGIN_ARTIFACT_TOO_LARGE", "Plugin artifact exceeds the safety limit");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new ProtocolError("PLUGIN_ARTIFACT_TOO_LARGE", "Plugin artifact exceeds the safety limit");
  return bytes;
}

function installContract(release) {
  const record = asRecord(release);
  if (!record) throw new ProtocolError("INVALID_ARGUMENT", "Plugin release must be an object");
  const releaseManifest = asRecord(record.releaseManifest);
  return asRecord(record.install) ?? asRecord(releaseManifest?.install) ?? releaseManifest ?? record;
}

function artifactForWeb(release) {
  const contract = installContract(release);
  const artifacts = Array.isArray(contract.artifacts) ? contract.artifacts : [];
  const candidate = artifacts.find((item) => {
    const artifact = asRecord(item);
    if (!artifact) return false;
    const platforms = Array.isArray(artifact.platforms) ? artifact.platforms.map(String) : [];
    return platforms.length === 0 || platforms.includes("web");
  });
  const artifact = asRecord(candidate);
  if (!artifact) throw new ProtocolError("PLUGIN_ARTIFACT_MISSING", "Plugin release has no Web artifact");
  const source = asRecord(artifact.source);
  const urlText = String(source?.url ?? artifact.url ?? "").trim();
  const digest = String(artifact.sha256 ?? artifact.artifactSha256 ?? "").trim().toLowerCase();
  const format = String(artifact.format ?? artifact.archiveFormat ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new ProtocolError("PLUGIN_DIGEST_MISSING", "Plugin artifact requires a SHA-256 digest");
  let url;
  try { url = new URL(urlText); } catch { throw new ProtocolError("PLUGIN_ARTIFACT_MISSING", "Plugin artifact URL is invalid"); }
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) {
    throw new ProtocolError("PLUGIN_ARTIFACT_URL_DENIED", "Plugin artifacts must use HTTPS");
  }
  if (format !== "tar-gz" && format !== "tar.gz" && format !== "tgz") {
    throw new ProtocolError("PLUGIN_FORMAT_UNSUPPORTED", `Unsupported Web plugin format: ${format || "unknown"}`);
  }
  return {
    id: typeof artifact.id === "string" ? artifact.id : "web-artifact",
    url: url.toString(),
    digest,
    format,
    entry: typeof artifact.entry === "string" && artifact.entry.trim() ? normalizeTarPath(artifact.entry.trim()) : "index.html",
    runtime: typeof artifact.runtime === "string" ? artifact.runtime : "local-web",
  };
}

function normalizeMarketplacePlugin(candidate) {
  const item = asRecord(candidate);
  if (!item) return null;
  const pluginId = String(item.pluginId ?? item.id ?? "").trim();
  if (!pluginId) return null;
  return {
    pluginId,
    displayName: String(item.displayName ?? item.title ?? item.name ?? pluginId),
    description: String(item.description ?? ""),
    latestVersion: String(item.latestVersion ?? item.version ?? ""),
    platforms: Array.isArray(item.platforms) ? item.platforms.map(String) : undefined,
    releaseStatus: typeof item.releaseStatus === "string" ? item.releaseStatus : undefined,
    releaseManifest: asRecord(item.releaseManifest) ?? undefined,
    install: asRecord(item.install) ?? undefined,
    source: asRecord(item.source) ?? undefined,
    bot: asRecord(item.bot) ?? undefined,
    commands: Array.isArray(item.commands) ? item.commands : undefined,
    surfaces: Array.isArray(item.surfaces) ? item.surfaces : undefined,
    installMode: typeof item.installMode === "string" ? item.installMode : undefined,
  };
}

export class HostProductService {
  constructor({
    dataDir = process.env.FABUSHI_HOST_DATA_DIR || path.resolve(".data/host"),
    platformApiBase = process.env.FABUSHI_PLATFORM_API_BASE_URL || process.env.FABUSHI_MAHAYANA_API_BASE_URL || "https://api.ombhrum.com",
  } = {}) {
    this.dataDir = dataDir;
    this.installRoot = path.join(dataDir, "plugins");
    this.store = new AtomicJsonStore(path.join(dataDir, "product-state.json"), initialProductState);
    this.mcp = new McpClientPool();
    this.remoteComputer = new RemoteComputerService({ dataDir, platformApiBase });
    this.attachments = new AttachmentService({ dataDir });
    this.platformApiBase = platformApiBase.replace(/\/$/, "");
  }

  async invoke(ownerId, method, args = {}) {
    requireString(ownerId, "ownerId", { max: 256 });
    if (method.startsWith("remote.")) return await this.remoteComputer.invoke(ownerId, method, args);
    switch (method) {
      case "marketplace.browse": return await this.marketplaceBrowse(args.query);
      case "marketplace.release": return await this.marketplaceRelease(args.pluginId, args.version);
      case "plugin.install": return await this.pluginInstall(ownerId, args.release, args.platform);
      case "plugin.uninstall": return await this.pluginUninstall(ownerId, args.pluginId);
      case "plugin.rollback": return await this.pluginRollback(ownerId, args.pluginId);
      case "plugin.active": return await this.pluginActive(ownerId, args.pluginId);
      case "plugin.listInstalled": return await this.pluginListInstalled(ownerId);
      case "plugin.uiDocument": return await this.pluginUiDocument(ownerId, args.pluginId);
      default: throw new ProtocolError("METHOD_NOT_FOUND", `Host product method is not supported: ${method}`);
    }
  }

  async runtimeCommand(ownerId, command) {
    if (command.type.startsWith("attachment.") || command.type === "search.media") return await this.attachments.runtimeCommand(ownerId, command);
    const ownerState = await this.#ownerState(ownerId);
    switch (command.type) {
      case "mcp.list": {
        const servers = [];
        for (const server of this.mcp.listConfigured()) {
          if (ownerState.mcp?.[server.id]?.removed) continue;
          try {
            const tools = await this.mcp.listTools(server.id);
            servers.push({
              name: server.id,
              displayName: server.name,
              status: "connected",
              transport: "streamable_http",
              customInstructions: ownerState.mcp?.[server.id]?.customInstructions ?? "",
              tools: tools.map((tool) => ({
                name: String(tool?.name ?? ""),
                description: String(tool?.description ?? ""),
                disabled: Boolean(ownerState.mcp?.[server.id]?.disabledTools?.[String(tool?.name ?? "")]),
                inputSchema: asRecord(tool?.inputSchema) ?? undefined,
              })),
            });
          } catch (error) {
            servers.push({
              name: server.id,
              displayName: server.name,
              status: error?.code === "MCP_SERVER_NOT_CONFIGURED" ? "disconnected" : "error",
              error: error instanceof Error ? error.message : String(error),
              transport: "streamable_http",
              tools: [],
            });
          }
        }
        return [{ type: "mcp.listed", timestamp: nowIso(), servers }];
      }
      case "mcp.apps": {
        const apps = this.mcp.listConfigured()
          .filter((server) => !ownerState.mcp?.[server.id]?.removed)
          .map((server) => ({
            id: server.id,
            name: server.name,
            transport: "streamable_http",
            oauthAvailable: Boolean(server.oauthAuthorizationUrl),
          }));
        return [{ type: "mcp.apps", timestamp: nowIso(), apps }];
      }
      case "mcp.oauthLogin": {
        const server = this.mcp.server(command.server);
        if (!server.oauthAuthorizationUrl) {
          throw new ProtocolError("MCP_OAUTH_NOT_CONFIGURED", `MCP server ${server.id} has no OAuth authorization URL`);
        }
        return [{
          type: "mcp.oauth",
          timestamp: nowIso(),
          server: server.id,
          authorizationUrl: server.oauthAuthorizationUrl,
          removed: false,
        }];
      }
      case "mcp.oauthLogout":
        await this.mcp.oauthLogout(command.server);
        return [{ type: "mcp.oauth", timestamp: nowIso(), server: command.server, removed: true }];
      case "mcp.remove":
        await this.#mutateMcp(ownerId, command.server, (state) => { state.removed = true; });
        this.mcp.clear(command.server);
        return [{ type: "mcp.refreshed", timestamp: nowIso() }];
      case "mcp.setCustomInstructions":
        await this.#mutateMcp(ownerId, command.server, (state) => {
          state.customInstructions = String(command.instructions ?? "").slice(0, 16_000);
        });
        return [{ type: "mcp.refreshed", timestamp: nowIso() }];
      case "mcp.setToolDisabled":
        await this.#mutateMcp(ownerId, command.server, (state) => {
          state.disabledTools ??= {};
          state.disabledTools[String(command.tool)] = Boolean(command.disabled);
        });
        return [{ type: "mcp.refreshed", timestamp: nowIso() }];
      case "mcp.refresh":
        this.mcp.clear();
        return [{ type: "mcp.refreshed", timestamp: nowIso() }];
      case "mcp.toolCall": {
        const serverState = ownerState.mcp?.[command.server];
        if (serverState?.removed) throw new ProtocolError("MCP_SERVER_DISABLED", `MCP server is removed for this user: ${command.server}`);
        if (serverState?.disabledTools?.[command.tool]) throw new ProtocolError("MCP_TOOL_DISABLED", `MCP tool is disabled: ${command.server}/${command.tool}`);
        const result = await this.mcp.callTool(command.server, command.tool, command.arguments);
        return [{ type: "mcp.toolResult", timestamp: nowIso(), server: command.server, tool: command.tool, result }];
      }
      case "marketplace.install": {
        const release = await this.marketplaceRelease(command.miniAppId);
        const pointer = await this.pluginInstall(ownerId, release, "web");
        return [{
          type: "marketplace.installed",
          timestamp: nowIso(),
          miniAppId: command.miniAppId,
          version: pointer.version,
        }];
      }
      case "miniapp.open": {
        const document = await this.pluginUiDocument(ownerId, command.miniAppId);
        return [{ type: "miniapp.opened", timestamp: nowIso(), miniAppId: command.miniAppId, html: document.html }];
      }
      default:
        throw new ProtocolError("COMMAND_NOT_IMPLEMENTED", `Host product command is not implemented: ${command.type}`);
    }
  }

  async marketplaceBrowse(query) {
    const url = new URL("/v1/marketplace/plugins", this.platformApiBase);
    const term = typeof query === "string" ? query.trim() : "";
    if (term) url.searchParams.set("query", term);
    url.searchParams.set("platform", "web");
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(process.env.FABUSHI_PLATFORM_SERVICE_TOKEN
          ? { authorization: `Bearer ${process.env.FABUSHI_PLATFORM_SERVICE_TOKEN}` }
          : {}),
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (!response.ok) throw new ProtocolError("MARKETPLACE_UNAVAILABLE", `Marketplace returned HTTP ${response.status}`);
    const payload = await response.json();
    const items = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.plugins)
        ? payload.plugins
        : Array.isArray(payload?.items)
          ? payload.items
          : [];
    const plugins = items.map(normalizeMarketplacePlugin).filter(Boolean);
    return { plugins };
  }

  async marketplaceRelease(pluginId, requestedVersion) {
    const id = safeSegment(pluginId, "pluginId");
    const { plugins } = await this.marketplaceBrowse(id);
    const plugin = plugins.find((candidate) => candidate.pluginId === id);
    if (!plugin) throw new ProtocolError("MARKETPLACE_PLUGIN_NOT_FOUND", `Marketplace plugin not found: ${id}`);
    const version = String(requestedVersion ?? plugin.latestVersion ?? "").trim();
    if (!version) throw new ProtocolError("MARKETPLACE_RELEASE_MISSING", `Marketplace plugin ${id} has no release version`);
    if (requestedVersion && plugin.latestVersion && version !== plugin.latestVersion) {
      throw new ProtocolError("MARKETPLACE_RELEASE_MISSING", `Marketplace did not return requested release ${id}@${version}`);
    }
    const releaseManifest = asRecord(plugin.releaseManifest);
    const install = asRecord(plugin.install) ?? asRecord(releaseManifest?.install);
    if (!releaseManifest && !install) {
      throw new ProtocolError("MARKETPLACE_RELEASE_MISSING", `Marketplace release metadata is incomplete for ${id}@${version}`);
    }
    return {
      pluginId: id,
      version,
      releaseStatus: plugin.releaseStatus,
      releaseManifest: releaseManifest ?? { pluginId: id, version, install },
      ...(install ? { install } : {}),
    };
  }

  async pluginInstall(ownerId, release, platform = "web") {
    if (platform && platform !== "web") throw new ProtocolError("PLUGIN_PLATFORM_UNSUPPORTED", "Web Host only installs Web plugin artifacts");
    const record = asRecord(release);
    if (!record) throw new ProtocolError("INVALID_ARGUMENT", "Plugin release must be an object");
    const pluginId = safeSegment(record.pluginId ?? asRecord(record.releaseManifest)?.pluginId, "pluginId");
    const version = safeSegment(record.version ?? asRecord(record.releaseManifest)?.version, "version");
    const artifact = artifactForWeb(record);
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
    if (!response.ok) throw new ProtocolError("PLUGIN_DOWNLOAD_FAILED", `Plugin artifact returned HTTP ${response.status}`);
    const bytes = await responseBytes(response);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== artifact.digest) {
      throw new ProtocolError("PLUGIN_DIGEST_MISMATCH", `Plugin artifact digest mismatch for ${pluginId}@${version}`);
    }
    const installPath = path.join(this.installRoot, ownerKey(ownerId), pluginId, version, digest.slice(0, 16));
    await rm(installPath, { recursive: true, force: true });
    await mkdir(installPath, { recursive: true });
    await extractTarGz(bytes, installPath);
    const entryPath = path.join(installPath, artifact.entry);
    const relativeCheck = path.relative(installPath, entryPath);
    if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) throw new ProtocolError("PLUGIN_ENTRY_INVALID", "Plugin entry escaped install root");
    try { await readFile(entryPath); } catch { throw new ProtocolError("PLUGIN_ENTRY_MISSING", `Plugin entry is missing: ${artifact.entry}`); }
    const pointer = {
      pluginId,
      version,
      artifactId: artifact.id,
      artifactSha256: digest,
      runtime: artifact.runtime,
      entry: artifact.entry,
      requestedPermissions: Array.isArray(installContract(record).permissions) ? installContract(record).permissions.map(String) : [],
      installedPath: installPath,
    };
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      const previous = owner.plugins.active[pluginId];
      if (previous) {
        owner.plugins.history[pluginId] ??= [];
        owner.plugins.history[pluginId].push(previous);
        owner.plugins.history[pluginId] = owner.plugins.history[pluginId].slice(-5);
      }
      owner.plugins.active[pluginId] = pointer;
    });
    return pointer;
  }

  async pluginUninstall(ownerId, pluginId) {
    const id = safeSegment(pluginId, "pluginId");
    let pointer = null;
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      pointer = owner.plugins.active[id] ?? null;
      delete owner.plugins.active[id];
      delete owner.plugins.history[id];
    });
    if (pointer?.installedPath) await this.#removeInstallPath(pointer.installedPath);
    return { pluginId: id, removed: Boolean(pointer), permissionsRemoved: true };
  }

  async pluginRollback(ownerId, pluginId) {
    const id = safeSegment(pluginId, "pluginId");
    let pointer = null;
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      const history = owner.plugins.history[id] ?? [];
      pointer = history.pop() ?? null;
      if (pointer) owner.plugins.active[id] = pointer;
      owner.plugins.history[id] = history;
    });
    return pointer;
  }

  async pluginActive(ownerId, pluginId) {
    const id = safeSegment(pluginId, "pluginId");
    const owner = await this.#ownerState(ownerId);
    return owner.plugins?.active?.[id] ?? null;
  }

  async pluginListInstalled(ownerId) {
    const owner = await this.#ownerState(ownerId);
    return { plugins: Object.values(owner.plugins?.active ?? {}) };
  }

  async pluginUiDocument(ownerId, pluginId) {
    const pointer = await this.pluginActive(ownerId, pluginId);
    if (!pointer) throw new ProtocolError("PLUGIN_NOT_INSTALLED", `Plugin is not installed: ${pluginId}`);
    const root = path.resolve(pointer.installedPath);
    const entry = path.resolve(root, pointer.entry || "index.html");
    const relative = path.relative(root, entry);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ProtocolError("PLUGIN_ENTRY_INVALID", "Plugin entry escaped install root");
    const bytes = await readFile(entry);
    if (bytes.length > MAX_UI_BYTES) throw new ProtocolError("PLUGIN_UI_TOO_LARGE", "Plugin UI document exceeds the safety limit");
    return { pluginId: pointer.pluginId, html: bytes.toString("utf8") };
  }

  async #ownerState(ownerId) {
    const state = await this.store.read();
    const key = ownerKey(ownerId);
    return state.owners?.[key] ?? { plugins: { active: {}, history: {} }, mcp: {} };
  }

  #ensureOwner(state, ownerId) {
    state.owners ??= {};
    const key = ownerKey(ownerId);
    state.owners[key] ??= { plugins: { active: {}, history: {} }, mcp: {} };
    state.owners[key].plugins ??= { active: {}, history: {} };
    state.owners[key].plugins.active ??= {};
    state.owners[key].plugins.history ??= {};
    state.owners[key].mcp ??= {};
    return state.owners[key];
  }

  async #mutateMcp(ownerId, serverId, mutator) {
    const server = this.mcp.server(serverId);
    await this.store.update((state) => {
      const owner = this.#ensureOwner(state, ownerId);
      owner.mcp[server.id] ??= { removed: false, customInstructions: "", disabledTools: {} };
      mutator(owner.mcp[server.id]);
    });
  }

  async #removeInstallPath(value) {
    const root = path.resolve(this.installRoot);
    const target = path.resolve(value);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
    await rm(target, { recursive: true, force: true });
  }
}
