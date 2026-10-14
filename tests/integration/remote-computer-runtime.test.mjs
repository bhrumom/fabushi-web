import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const ports = { platform: 18920, host: 18921, coordinator: 18922, web: 18923 };
const origin = "http://localhost:3000";

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
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Health check failed: ${url}`);
}
async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
async function authenticate() {
  const response = await fetch(`http://127.0.0.1:${ports.web}/v1/auth/session`, {
    method: "POST",
    headers: { authorization: "Bearer remote-integration-token", origin, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie?.()[0] || response.headers.get("set-cookie");
  assert.ok(cookie);
  return cookie.split(";")[0];
}
async function remoteRpc(cookie, method, args = {}) {
  const response = await fetch(`http://127.0.0.1:${ports.web}/v1/remote`, {
    method: "POST",
    headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({ method, args }),
  });
  const body = await response.json();
  if (!response.ok || body.ok !== true) throw new Error(body?.error?.message || `remote rpc HTTP ${response.status}`);
  return body.result;
}

test("Remote Computer secrets remain Host-owned while browser signaling stays functional", { timeout: 35_000 }, async (t) => {
  const children = [];
  const data = await mkdtemp(path.join(os.tmpdir(), "fabushi-web-remote-"));
  let accessToken = "access-token-original-1234567890";
  let refreshCount = 0;
  let firstComputerRequest = true;
  const clientToken = "client-token-abcdefghijklmnopqrstuvwxyz-123456";
  const mobileToken = "mobile-token-abcdefghijklmnopqrstuvwxyz-123456";
  const sessionId = "remote-session-1";
  const deviceId = "desktop-1";
  const clientId = "browser-client-1";

  const platform = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://platform.test");
    const body = req.method === "POST" ? await readJson(req) : {};
    res.setHeader("content-type", "application/json");

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      assert.equal(body.username, "alice");
      assert.equal(typeof body.password, "string");
      assert.match(body.deviceId, /^fabushi-web-/);
      res.end(JSON.stringify({
        accessToken,
        refreshToken: "refresh-token-original-1234567890",
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        refreshTokenExpiresAt: Math.floor(Date.now() / 1000) + 86400,
        sessionId: "auth-session-1",
        deviceId: body.deviceId,
        username: "alice",
        userId: "user-1",
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/refresh") {
      refreshCount += 1;
      accessToken = "access-token-refreshed-1234567890";
      res.end(JSON.stringify({
        accessToken,
        refreshToken: "refresh-token-refreshed-1234567890",
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 7200,
        refreshTokenExpiresAt: Math.floor(Date.now() / 1000) + 86400,
        sessionId: "auth-session-2",
        deviceId: body.deviceId,
        username: "alice",
        userId: "user-1",
      }));
      return;
    }

    const auth = req.headers.authorization;
    if (url.pathname.startsWith("/v1/") && auth !== `Bearer ${accessToken}`) {
      res.writeHead(401).end(JSON.stringify({ message: "unauthorized" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/computers") {
      if (firstComputerRequest) {
        firstComputerRequest = false;
        res.writeHead(401).end(JSON.stringify({ message: "refresh required" }));
        return;
      }
      res.end(JSON.stringify({
        computers: [{
          deviceId,
          label: "Desk Mac",
          lastSeenAt: Math.floor(Date.now() / 1000),
          createdAt: Math.floor(Date.now() / 1000) - 100,
          online: true,
          provider: "fabushi-webrtc",
          platform: "macos",
          appVersion: "1.0.0",
          capabilities: ["remote-desktop", "input", "clipboard"],
          activeSessionCount: 0,
        }],
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/computers/pair") {
      assert.equal(body.pairingCode, "ABCDEF123456");
      res.end(JSON.stringify({
        deviceId,
        computerLabel: "Desk Mac",
        clientId,
        clientToken,
        clientLabel: body.label,
        pairedAt: Math.floor(Date.now() / 1000),
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === `/v1/computers/${deviceId}/sessions`) {
      assert.equal(body.clientId, clientId);
      assert.equal(body.clientToken, clientToken);
      res.end(JSON.stringify({
        sessionId,
        deviceId,
        clientId,
        mobileToken,
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        state: "pending",
        permissions: { display: true, input: true, clipboard: true, fileTransfer: false, audio: false },
        iceServers: [{ urls: "stun:stun.example.test:3478" }],
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === `/v1/computers/${deviceId}/signals`) {
      assert.equal(body.sessionId, sessionId);
      assert.equal(body.clientId, clientId);
      assert.equal(body.mobileToken, mobileToken);
      assert.ok(["offer", "ice", "ready", "close"].includes(body.kind));
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && url.pathname === `/v1/computers/${deviceId}/signals/drain`) {
      assert.equal(body.mobileToken, mobileToken);
      res.end(JSON.stringify({
        sessionId,
        lastSignalId: 1,
        signals: [{ signalId: 1, senderRole: "desktop", kind: "answer", payload: { type: "answer", sdp: "fixture" }, createdAt: Math.floor(Date.now() / 1000) }],
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === `/v1/computers/${deviceId}/sessions/${sessionId}/close`) {
      assert.equal(body.mobileToken, mobileToken);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404).end(JSON.stringify({ message: "not found" }));
  });

  await listen(platform, ports.platform);
  t.after(async () => {
    for (const child of children) child.kill("SIGTERM");
    await new Promise((resolve) => platform.close(resolve));
    await rm(data, { recursive: true, force: true });
  });

  const common = { NODE_ENV: "test", FABUSHI_INTERNAL_TOKEN: "remote-internal-token" };
  startNode("source/host/server.mjs", {
    ...common,
    FABUSHI_HOST_PORT: String(ports.host),
    FABUSHI_HOST_DATA_DIR: path.join(data, "host"),
    FABUSHI_PLATFORM_API_BASE_URL: `http://127.0.0.1:${ports.platform}`,
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
    FABUSHI_WEB_SESSION_SECRET: "remote-session-secret-1234567890",
    FABUSHI_DEV_BEARER_TOKEN: "remote-integration-token",
    FABUSHI_ALLOWED_ORIGINS: origin,
  }, children);

  await Promise.all([
    waitHealth(`http://127.0.0.1:${ports.host}/healthz`),
    waitHealth(`http://127.0.0.1:${ports.coordinator}/healthz`),
    waitHealth(`http://127.0.0.1:${ports.web}/healthz`),
  ]);

  const cookie = await authenticate();

  assert.deepEqual(await remoteRpc(cookie, "remote.authStatus"), { loggedIn: false });
  const login = await remoteRpc(cookie, "remote.login", { username: "alice", password: "correct horse battery staple" });
  assert.equal(login.loggedIn, true);
  assert.equal(login.username, "alice");
  assert.equal("accessToken" in login, false);
  assert.equal("refreshToken" in login, false);

  const computers = await remoteRpc(cookie, "remote.listComputers");
  assert.equal(computers[0].deviceId, deviceId);
  assert.equal(refreshCount, 1);

  const paired = await remoteRpc(cookie, "remote.pair", { pairingCode: "ABCDEF123456", label: "Browser" });
  assert.equal(paired.clientId, clientId);
  assert.equal("clientToken" in paired, false);

  const pairedMap = await remoteRpc(cookie, "remote.listPaired");
  assert.equal(pairedMap[deviceId].clientId, clientId);
  assert.equal("clientToken" in pairedMap[deviceId], false);

  const session = await remoteRpc(cookie, "remote.createSession", { deviceId, clientId });
  assert.equal(session.sessionId, sessionId);
  assert.equal("mobileToken" in session, false);
  assert.equal(session.iceServers[0].urls, "stun:stun.example.test:3478");

  await remoteRpc(cookie, "remote.signal", { sessionId, kind: "offer", payload: { type: "offer", sdp: "fixture-offer" } });
  const drained = await remoteRpc(cookie, "remote.drainSignals", { sessionId, afterSignalId: 0 });
  assert.equal(drained.signals[0].kind, "answer");

  const closed = await remoteRpc(cookie, "remote.closeSession", { sessionId });
  assert.equal(closed.closed, true);

  await remoteRpc(cookie, "remote.logout");
  assert.deepEqual(await remoteRpc(cookie, "remote.authStatus"), { loggedIn: false });
});
