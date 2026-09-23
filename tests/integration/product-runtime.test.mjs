import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectWebSocket } from "./ws-client.mjs";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const ports = { marketplace: 18910, mcp: 18911, host: 18912, coordinator: 18913, web: 18914 };
const origin = "http://localhost:3000";

function tarOctal(value, width) {
  const text = value.toString(8).padStart(width - 1, "0") + "\0";
  return Buffer.from(text, "ascii");
}

function makeTarGz(files) {
  const blocks = [];
  for (const [name, bodyText] of Object.entries(files)) {
    const body = Buffer.from(bodyText, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    tarOctal(0o600, 8).copy(header, 100);
    tarOctal(0, 8).copy(header, 108);
    tarOctal(0, 8).copy(header, 116);
    tarOctal(body.length, 12).copy(header, 124);
    tarOctal(Math.floor(Date.now() / 1000), 12).copy(header, 136);
    Buffer.from("        ", "ascii").copy(header, 148);
    header[156] = "0".charCodeAt(0);
    header.write("ustar", 257, 5, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = checksum.toString(8).padStart(6, "0") + "\0 ";
    Buffer.from(checksumText, "ascii").copy(header, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function startNode(script, env, children) {
  const child = spawn(process.execPath, [path.join(root, script)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  children.push(child);
  return child;
}

async function waitHealth(url) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Health check failed: ${url}`);
}

function requestFrame(requestId, method, args) {
  return { protocolVersion: 1, kind: "request", requestId, method, args };
}

async function authenticate() {
  const response = await fetch(`http://127.0.0.1:${ports.web}/v1/auth/session`, {
    method: "POST",
    headers: {
      authorization: "Bearer product-integration-token",
      origin,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie?.()[0] || response.headers.get("set-cookie");
  assert.ok(cookie);
  return cookie.split(";")[0];
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

test("Marketplace, MCP and approvals traverse Web Main -> Coordinator -> Host", { timeout: 35_000 }, async (t) => {
  const children = [];
  const data = await mkdtemp(path.join(os.tmpdir(), "fabushi-web-product-"));
  const artifact = makeTarGz({
    "index.html": "<!doctype html><title>Fixture Plugin</title><main>installed fixture plugin</main>",
    "manifest.json": JSON.stringify({ id: "fixture-plugin", version: "1.0.0" }),
  });
  const artifactSha256 = createHash("sha256").update(artifact).digest("hex");

  const marketplace = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://marketplace.test");
    if (url.pathname === "/v1/marketplace/plugins") {
      const install = {
        protocol: "fabushi.marketplace.install.v1",
        pluginId: "fixture-plugin",
        version: "1.0.0",
        artifacts: [{
          id: "fixture-web",
          runtime: "local-web",
          platforms: ["web"],
          source: { type: "https", url: `http://127.0.0.1:${ports.marketplace}/plugin.tgz` },
          sha256: artifactSha256,
          size: artifact.length,
          format: "tar-gz",
          entry: "index.html",
        }],
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        plugins: [{
          pluginId: "fixture-plugin",
          displayName: "Fixture Plugin",
          description: "Product integration fixture",
          latestVersion: "1.0.0",
          platforms: ["web"],
          releaseStatus: "approved",
          releaseManifest: { pluginId: "fixture-plugin", version: "1.0.0", install },
          install,
        }],
      }));
      return;
    }
    if (url.pathname === "/plugin.tgz") {
      res.writeHead(200, { "content-type": "application/gzip", "content-length": String(artifact.length) });
      res.end(artifact);
      return;
    }
    res.writeHead(404).end();
  });

  const mcp = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    res.setHeader("content-type", "application/json");
    res.setHeader("mcp-session-id", "fixture-session");
    if (payload.method === "initialize") {
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fixture-mcp", version: "1.0.0" },
        },
      }));
      return;
    }
    if (payload.method === "notifications/initialized") {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (payload.method === "tools/list") {
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          tools: [{
            name: "echo",
            description: "Echo a value",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          }],
        },
      }));
      return;
    }
    if (payload.method === "tools/call") {
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          content: [{ type: "text", text: String(payload.params?.arguments?.text ?? "") }],
          structuredContent: { echoed: payload.params?.arguments?.text ?? null },
          isError: false,
        },
      }));
      return;
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { code: -32601, message: "method not found" } }));
  });

  await listen(marketplace, ports.marketplace);
  await listen(mcp, ports.mcp);

  t.after(async () => {
    for (const child of children) child.kill("SIGTERM");
    await Promise.all([
      new Promise((resolve) => marketplace.close(resolve)),
      new Promise((resolve) => mcp.close(resolve)),
    ]);
    await rm(data, { recursive: true, force: true });
  });

  const common = { NODE_ENV: "test", FABUSHI_INTERNAL_TOKEN: "product-internal-token" };
  startNode("source/host/server.mjs", {
    ...common,
    FABUSHI_HOST_PORT: String(ports.host),
    FABUSHI_HOST_DATA_DIR: path.join(data, "host"),
    FABUSHI_PLATFORM_API_BASE_URL: `http://127.0.0.1:${ports.marketplace}`,
    FABUSHI_MCP_SERVERS_JSON: JSON.stringify([{
      id: "fixture",
      name: "Fixture MCP",
      url: `http://127.0.0.1:${ports.mcp}/mcp`,
      protocolVersion: "2025-11-25",
    }]),
  }, children);
  startNode("source/mahayana-agent-coordinator/server.mjs", {
    ...common,
    FABUSHI_COORDINATOR_PORT: String(ports.coordinator),
    FABUSHI_HOST_URL: `http://127.0.0.1:${ports.host}`,
    FABUSHI_COORDINATOR_DATA_DIR: path.join(data, "coordinator"),
  }, children);
  startNode("source/web-main/server.mjs", {
    ...common,
    FABUSHI_WEB_MAIN_PORT: String(ports.web),
    FABUSHI_COORDINATOR_URL: `http://127.0.0.1:${ports.coordinator}`,
    FABUSHI_WEB_SESSION_SECRET: "product-session-secret-123456789",
    FABUSHI_DEV_BEARER_TOKEN: "product-integration-token",
    FABUSHI_ALLOWED_ORIGINS: origin,
  }, children);

  await Promise.all([
    waitHealth(`http://127.0.0.1:${ports.host}/healthz`),
    waitHealth(`http://127.0.0.1:${ports.coordinator}/healthz`),
    waitHealth(`http://127.0.0.1:${ports.web}/healthz`),
  ]);

  const cookie = await authenticate();
  const ws = await connectWebSocket({ port: ports.web, cookie, origin });
  await ws.waitFor((message) => message.kind === "lifecycle" && message.type === "ready");
  ws.sendJson({ protocolVersion: 1, kind: "lifecycle", type: "hello", afterSeq: 0 });
  await ws.waitFor((message) => message.kind === "lifecycle" && message.type === "ready");

  ws.sendJson(requestFrame("market-browse", "marketplace.browse", { query: "fixture" }));
  const browse = await ws.waitFor((message) => message.kind === "reply" && message.requestId === "market-browse");
  assert.equal(browse.ok, true);
  assert.equal(browse.result.plugins[0].pluginId, "fixture-plugin");

  ws.sendJson(requestFrame("market-release", "marketplace.release", { pluginId: "fixture-plugin", version: "1.0.0" }));
  const releaseReply = await ws.waitFor((message) => message.kind === "reply" && message.requestId === "market-release");
  assert.equal(releaseReply.ok, true);

  ws.sendJson(requestFrame("plugin-install", "plugin.install", { release: releaseReply.result, platform: "web" }));
  const installReply = await ws.waitFor((message) => message.kind === "reply" && message.requestId === "plugin-install", 8000);
  assert.equal(installReply.ok, true);
  assert.equal(installReply.result.artifactSha256, artifactSha256);

  ws.sendJson(requestFrame("plugin-ui", "plugin.uiDocument", { pluginId: "fixture-plugin" }));
  const uiReply = await ws.waitFor((message) => message.kind === "reply" && message.requestId === "plugin-ui");
  assert.match(uiReply.result.html, /installed fixture plugin/);

  ws.sendJson(requestFrame("mcp-list", "runtime.execute", {
    command: { type: "mcp.list", requestId: "mcp-list-command" },
  }));
  const mcpListAccepted = await ws.waitFor((message) => message.kind === "reply" && message.requestId === "mcp-list");
  assert.equal(mcpListAccepted.ok, true);
  const listed = await ws.waitFor((message) =>
    message.kind === "event" &&
    message.event?.type === "mcp.listed" &&
    message.event.servers?.some?.((server) => server.name === "fixture"),
  );
  assert.equal(listed.event.servers[0].tools[0].name, "echo");

  ws.sendJson(requestFrame("mcp-call", "runtime.execute", {
    command: { type: "mcp.toolCall", requestId: "mcp-call-command", server: "fixture", tool: "echo", arguments: { text: "hello-mcp" } },
  }));
  const mcpCallAccepted = await ws.waitFor((message) => message.kind === "reply" && message.requestId === "mcp-call");
  assert.equal(mcpCallAccepted.ok, true);
  const toolResult = await ws.waitFor((message) => message.kind === "event" && message.event?.type === "mcp.toolResult");
  assert.equal(toolResult.event.result.structuredContent.echoed, "hello-mcp");

  ws.sendJson(requestFrame("approval-request", "runtime.execute", {
    command: {
      type: "capability.request",
      requestId: "approval-command",
      miniAppId: "fixture-plugin",
      capability: "network",
      reason: "Fixture needs one network call",
    },
  }));
  const approvalAccepted = await ws.waitFor((message) => message.kind === "reply" && message.requestId === "approval-request");
  assert.equal(approvalAccepted.ok, true);
  const approval = await ws.waitFor((message) => message.kind === "event" && message.event?.type === "approval.requested");
  assert.equal(approval.event.miniAppId, "fixture-plugin");

  ws.sendJson(requestFrame("approval-resolve", "runtime.approval", {
    approvalId: approval.event.approvalId,
    decision: "allow-once",
  }));
  const resolvedReply = await ws.waitFor((message) => message.kind === "reply" && message.requestId === "approval-resolve");
  assert.equal(resolvedReply.ok, true);
  const resolved = await ws.waitFor((message) => message.kind === "event" && message.event?.type === "approval.resolved");
  assert.equal(resolved.event.decision, "allow-once");

  ws.sendJson(requestFrame("plugin-uninstall", "plugin.uninstall", { pluginId: "fixture-plugin" }));
  const uninstall = await ws.waitFor((message) => message.kind === "reply" && message.requestId === "plugin-uninstall");
  assert.equal(uninstall.result.removed, true);
  ws.close();
});
