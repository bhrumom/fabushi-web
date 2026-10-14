import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const ports = { coordinator: 19102, web: 19103, introspection: 19104 };
const allowedOrigin = "https://web.example.test";
const internalToken = "security-internal-token";
const sessionSecret = "security-session-secret-123456789012345";

function start(script, env) {
  const child = spawn(process.execPath, [path.join(root, script)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitHealth(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Health check failed: ${url}`);
}

async function upgradeStatus({ origin, cookie }) {
  return await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: ports.web });
    let response = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("WebSocket upgrade timed out")); }, 5000);
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      const firstLine = response.split("\r\n", 1)[0];
      socket.destroy();
      resolve(firstLine);
    });
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      const headers = [
        "GET /v1/coordinator HTTP/1.1",
        `Host: 127.0.0.1:${ports.web}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...(origin ? [`Origin: ${origin}`] : []),
        ...(cookie ? [`Cookie: ${cookie}`] : []),
        "",
        "",
      ];
      socket.write(headers.join("\r\n"));
    });
  });
}

test("production Web Main fails closed for origin/session/dev-token boundaries", { timeout: 30_000 }, async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), "fabushi-web-security-"));
  const children = [];
  const introspection = http.createServer((req, res) => {
    const valid = req.headers.authorization === "Bearer prod-access-token";
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(valid ? { active: true, sub: "security-user" } : { active: false }));
  });
  await new Promise((resolve, reject) => {
    introspection.once("error", reject);
    introspection.listen(ports.introspection, "127.0.0.1", resolve);
  });

  t.after(async () => {
    for (const child of children) {
      try { child.kill("SIGTERM"); } catch {}
    }
    await new Promise((resolve) => introspection.close(resolve));
    await rm(data, { recursive: true, force: true });
  });

  children.push(start("source/mahayana-agent-coordinator/server.mjs", {
    NODE_ENV: "production",
    FABUSHI_INTERNAL_TOKEN: internalToken,
    FABUSHI_COORDINATOR_PORT: String(ports.coordinator),
    FABUSHI_COORDINATOR_DATA_DIR: path.join(data, "coordinator"),
  }));
  children.push(start("source/web-main/server.mjs", {
    NODE_ENV: "production",
    FABUSHI_INTERNAL_TOKEN: internalToken,
    FABUSHI_WEB_MAIN_PORT: String(ports.web),
    FABUSHI_COORDINATOR_URL: `http://127.0.0.1:${ports.coordinator}`,
    FABUSHI_WEB_SESSION_SECRET: sessionSecret,
    FABUSHI_AUTH_INTROSPECTION_URL: `http://127.0.0.1:${ports.introspection}/introspect`,
    FABUSHI_DEV_BEARER_TOKEN: "dev-token-must-not-work-in-production",
    FABUSHI_ALLOWED_ORIGINS: allowedOrigin,
  }));

  await Promise.all([
    waitHealth(`http://127.0.0.1:${ports.coordinator}/healthz`),
    waitHealth(`http://127.0.0.1:${ports.web}/healthz`),
  ]);

  const sessionRequest = (origin, token) => fetch(`http://127.0.0.1:${ports.web}/v1/auth/session`, {
    method: "POST",
    headers: {
      ...(origin ? { origin } : {}),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: "{}",
  });

  assert.equal((await sessionRequest("https://evil.example.test", "prod-access-token")).status, 403);
  assert.equal((await sessionRequest(undefined, "prod-access-token")).status, 403);
  assert.equal((await sessionRequest(allowedOrigin, "dev-token-must-not-work-in-production")).status, 401);

  const valid = await sessionRequest(allowedOrigin, "prod-access-token");
  assert.equal(valid.status, 200);
  const setCookie = valid.headers.getSetCookie?.()[0] || valid.headers.get("set-cookie") || "";
  assert.match(setCookie, /fabushi_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Secure/i);
  const cookie = setCookie.split(";")[0];

  const status = await fetch(`http://127.0.0.1:${ports.web}/v1/auth/status`, { headers: { cookie } });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).loggedIn, true);

  const tampered = cookie.slice(0, -1) + (cookie.endsWith("a") ? "b" : "a");
  assert.equal((await fetch(`http://127.0.0.1:${ports.web}/v1/auth/status`, { headers: { cookie: tampered } })).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${ports.web}/v1/auth/logout`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  })).status, 403);

  assert.match(await upgradeStatus({ origin: "https://evil.example.test", cookie }), /^HTTP\/1\.1 403 /);
  assert.match(await upgradeStatus({ origin: allowedOrigin }), /^HTTP\/1\.1 401 /);
  assert.match(await upgradeStatus({ origin: allowedOrigin, cookie }), /^HTTP\/1\.1 101 /);

  const coordinatorDenied = await fetch(`http://127.0.0.1:${ports.coordinator}/v1/request`, {
    method: "POST",
    headers: { "x-fabushi-owner": "security-user", "content-type": "application/json" },
    body: JSON.stringify({ method: "runtime.resync", args: { afterSeq: 0 } }),
  });
  assert.equal(coordinatorDenied.status, 401);
});
