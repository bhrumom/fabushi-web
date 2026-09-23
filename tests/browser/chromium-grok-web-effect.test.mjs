import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const ports = { runner: 18990, host: 18991, coordinator: 18992, web: 18993, next: 13000, cdp: 19222 };
const origin = `http://127.0.0.1:${ports.next}`;
const artifacts = path.join(root, "artifacts", "grok-web-chromium");

function start(command, args, { cwd = root, env = {} } = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${path.basename(command)}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${path.basename(command)}] ${chunk}`));
  return child;
}

function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try { child.kill("SIGTERM"); } catch {}
}

function contentType(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json" || extension === ".webmanifest") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

async function resolveStaticFile(rootDir, pathname) {
  const decoded = decodeURIComponent(pathname.split("?")[0]);
  const relative = decoded.replace(/^\/+/, "");
  const candidates = [];
  if (!relative) candidates.push("index.html");
  else {
    candidates.push(relative);
    if (!path.extname(relative)) {
      candidates.push(`${relative}.html`);
      candidates.push(path.join(relative, "index.html"));
    }
  }
  for (const candidate of candidates) {
    const full = path.resolve(rootDir, candidate);
    if (!full.startsWith(path.resolve(rootDir) + path.sep) && full !== path.resolve(rootDir)) continue;
    try {
      const info = await stat(full);
      if (info.isFile()) return full;
    } catch {}
  }
  return null;
}

async function startStaticExportServer(rootDir, port) {
  const server = http.createServer(async (req, res) => {
    try {
      const file = await resolveStaticFile(rootDir, new URL(req.url || "/", "http://static.local").pathname);
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const bytes = await readFile(file);
      res.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
      res.end(bytes);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function waitHttp(url, { timeoutMs = 30_000, expectedStatus } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (expectedStatus ? response.status === expectedStatus : response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function resolveChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const candidate of ["google-chrome", "google-chrome-stable", "chrome", "chromium", "chromium-browser"]) {
    const found = spawnSync("sh", ["-lc", `command -v ${candidate}`], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error("Chrome/Chromium executable was not found");
}

async function chromeTarget() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${ports.cdp}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((item) => item.type === "page" && typeof item.webSocketDebuggerUrl === "string");
        if (target) return target;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome DevTools endpoint did not become ready");
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("CDP socket closed"));
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out opening CDP WebSocket")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket failed")); }, { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.socket.close(); } catch {}
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  return result.result?.value;
}

async function waitExpression(cdp, expression, { timeoutMs = 20_000, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(cdp, expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function screenshot(cdp, name) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(path.join(artifacts, name), Buffer.from(result.data, "base64"));
}

async function authenticate() {
  const response = await fetch(`http://127.0.0.1:${ports.web}/v1/auth/session`, {
    method: "POST",
    headers: {
      authorization: "Bearer browser-e2e-token",
      origin,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.getSetCookie?.()[0] || response.headers.get("set-cookie") || "";
  const match = /(?:^|;\s*)fabushi_session=([^;]+)/.exec(setCookie);
  assert.ok(match, "Web Main did not return the authenticated session cookie");
  return decodeURIComponent(match[1]);
}

async function coordinatorResync() {
  const response = await fetch(`http://127.0.0.1:${ports.coordinator}/v1/request`, {
    method: "POST",
    headers: {
      authorization: "Bearer browser-e2e-internal-token",
      "x-fabushi-owner": "test-user",
      "content-type": "application/json",
    },
    body: JSON.stringify({ method: "runtime.resync", args: { afterSeq: 0 } }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  return body.result;
}

test("real Chromium reload restores the same durable tool-running run and completes once", { timeout: 90_000 }, async (t) => {
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true });
  const data = await mkdtemp(path.join(os.tmpdir(), "fabushi-web-browser-"));
  const children = [];
  let cdp;
  t.after(async () => {
    cdp?.close();
    for (const child of children.reverse()) terminate(child);
    await rm(data, { recursive: true, force: true });
  });

  const common = { NODE_ENV: "test", FABUSHI_INTERNAL_TOKEN: "browser-e2e-internal-token" };
  children.push(start(process.execPath, ["source/box-exec-daemon/server.mjs"], {
    env: { ...common, FABUSHI_RUNNER_PORT: String(ports.runner), FABUSHI_RUNNER_DATA_DIR: path.join(data, "runner") },
  }));
  children.push(start(process.execPath, ["source/host/server.mjs"], {
    env: {
      ...common,
      FABUSHI_HOST_PORT: String(ports.host),
      FABUSHI_RUNNER_URL: `http://127.0.0.1:${ports.runner}`,
      FABUSHI_HOST_DATA_DIR: path.join(data, "host"),
      FABUSHI_HOST_TEST_PROVIDER: "deterministic",
      FABUSHI_HOST_TEST_STEP_DELAY_MS: "8000",
    },
  }));
  children.push(start(process.execPath, ["source/mahayana-agent-coordinator/server.mjs"], {
    env: {
      ...common,
      FABUSHI_COORDINATOR_PORT: String(ports.coordinator),
      FABUSHI_HOST_URL: `http://127.0.0.1:${ports.host}`,
      FABUSHI_COORDINATOR_DATA_DIR: path.join(data, "coordinator"),
    },
  }));
  children.push(start(process.execPath, ["source/web-main/server.mjs"], {
    env: {
      ...common,
      FABUSHI_WEB_MAIN_PORT: String(ports.web),
      FABUSHI_COORDINATOR_URL: `http://127.0.0.1:${ports.coordinator}`,
      FABUSHI_WEB_SESSION_SECRET: "browser-e2e-session-secret-123456789",
      FABUSHI_DEV_BEARER_TOKEN: "browser-e2e-token",
      FABUSHI_ALLOWED_ORIGINS: origin,
    },
  }));

  await Promise.all([
    waitHttp(`http://127.0.0.1:${ports.runner}/healthz`),
    waitHttp(`http://127.0.0.1:${ports.host}/healthz`),
    waitHttp(`http://127.0.0.1:${ports.coordinator}/healthz`),
    waitHttp(`http://127.0.0.1:${ports.web}/healthz`),
  ]);

  const staticServer = await startStaticExportServer(path.join(root, "frontend", "apps", "web", "out"), ports.next);
  t.after(() => new Promise((resolve) => staticServer.close(resolve)));
  await waitHttp(`${origin}/host`, { timeoutMs: 10_000 });

  const sessionValue = await authenticate();
  const chrome = resolveChrome();
  children.push(start(chrome, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${ports.cdp}`,
    `--user-data-dir=${path.join(data, "chrome-profile")}`,
    "--window-size=1440,1000",
    "about:blank",
  ]));

  const target = await chromeTarget();
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  const cookieResult = await cdp.send("Network.setCookie", {
    name: "fabushi_session",
    value: sessionValue,
    url: `http://127.0.0.1:${ports.web}/`,
    httpOnly: true,
    sameSite: "Lax",
  });
  assert.equal(cookieResult.success, true);

  await cdp.send("Page.navigate", { url: `${origin}/host` });
  await waitExpression(cdp, "document.readyState === 'complete'", { label: "host page load" });
  await waitExpression(cdp, "document.querySelector('[data-testid=mahayana-host]') !== null", { label: "Mahayana host shell" });

  await evaluate(cdp, "localStorage.setItem('fabushi.host.onboarding-complete.v1', '1'); location.reload(); true");
  await waitExpression(cdp, "document.readyState === 'complete'", { label: "host reload after onboarding setup" });
  await waitExpression(cdp, "document.querySelector('[data-testid=host-status]')?.textContent?.includes('Host 已连接') === true", { timeoutMs: 20_000, label: "authenticated WebSocket Host ready" });
  assert.equal(await evaluate(cdp, "document.querySelector('[data-testid=login-gate]') === null"), true);

  const prompt = "Please inspect the runtime capabilities with the runtime tool and summarize them.";
  const inputValue = await evaluate(cdp, `(() => {
    const input = document.querySelector('[data-testid=chat-input]');
    if (!(input instanceof HTMLTextAreaElement)) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(prompt)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  assert.equal(inputValue, prompt);
  await waitExpression(cdp, "document.querySelector('[data-testid=send-message]')?.disabled === false", { label: "enabled send button" });
  assert.equal(await evaluate(cdp, "document.querySelector('[data-testid=send-message]')?.click(); true"), true);

  const operationId = await waitExpression(cdp, `(() => {
    const steps = [...document.querySelectorAll('[data-testid=agent-step][data-status=running]')];
    const tool = steps.find((node) => node.textContent?.includes('Tool ·'));
    return tool?.getAttribute('data-operation-id') || '';
  })()`, { timeoutMs: 15_000, label: "tool-running UI state" });
  assert.match(operationId, /^[0-9a-f-]{20,}$/i);
  await screenshot(cdp, "01-tool-running-before-reload.png");

  await cdp.send("Page.reload", { ignoreCache: true });
  await waitExpression(cdp, "document.readyState === 'complete'", { label: "browser reload" });
  await waitExpression(cdp, "document.querySelector('[data-testid=host-status]')?.textContent?.includes('Host 已连接') === true", { timeoutMs: 20_000, label: "Host ready after reload" });

  const restoredOperationId = await waitExpression(cdp, `(() => {
    const step = [...document.querySelectorAll('[data-testid=agent-step][data-status=running]')]
      .find((node) => node.getAttribute('data-operation-id') === ${JSON.stringify(operationId)});
    return step?.getAttribute('data-operation-id') || '';
  })()`, { timeoutMs: 10_000, label: "same tool-running operation restored after reload" });
  assert.equal(restoredOperationId, operationId);
  assert.equal(await evaluate(cdp, `document.querySelector('button[aria-label="停止任务"]') !== null`), true);
  await screenshot(cdp, "02-same-run-restored-after-reload.png");

  await waitExpression(cdp, `document.querySelector('[data-testid=messages]')?.textContent?.includes(${JSON.stringify(`Completed durable run ${operationId}`)}) === true`, {
    timeoutMs: 25_000,
    label: "same durable run final assistant response",
  });
  await screenshot(cdp, "03-same-run-completed.png");

  const resync = await coordinatorResync();
  const runEvents = resync.events.filter((record) => record.runId === operationId);
  assert.equal(runEvents.filter((record) => record.event?.type === "operation.started").length, 1);
  assert.equal(runEvents.filter((record) => record.event?.type === "agent.step" && record.event?.kind === "tool" && record.event?.status === "running").length, 1);
  assert.equal(runEvents.filter((record) => record.event?.type === "operation.completed").length, 1);
  assert.equal(resync.activeRuns.some((run) => run.operationId === operationId), false);

  await writeFile(path.join(artifacts, "evidence.json"), JSON.stringify({
    operationId,
    sameOperationRestored: restoredOperationId === operationId,
    operationStartedCount: runEvents.filter((record) => record.event?.type === "operation.started").length,
    toolRunningCount: runEvents.filter((record) => record.event?.type === "agent.step" && record.event?.kind === "tool" && record.event?.status === "running").length,
    completedCount: runEvents.filter((record) => record.event?.type === "operation.completed").length,
  }, null, 2));
});
