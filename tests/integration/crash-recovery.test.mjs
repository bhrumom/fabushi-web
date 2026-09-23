import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "crash-recovery-token";

function spawnNode(script, env) {
  const child = spawn(process.execPath, [path.join(root, script)], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", FABUSHI_INTERNAL_TOKEN: token, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[${path.basename(script)}] ${chunk}`));
  return child;
}

async function stopChild(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill(signal);
  const timeout = new Promise((resolve) => setTimeout(resolve, 2000, "timeout"));
  if (await Promise.race([exited.then(() => "exit"), timeout]) === "timeout" && child.exitCode === null && !child.signalCode) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function waitHealth(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = new Error(`HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Health check failed: ${url}: ${last instanceof Error ? last.message : String(last)}`);
}

async function requestCoordinator(port, ownerId, method, args = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/request`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-fabushi-owner": ownerId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ method, args }),
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.result;
}

async function sync(port, ownerId) {
  return await requestCoordinator(port, ownerId, "runtime.resync", { afterSeq: 0 });
}

async function waitSnapshot(port, ownerId, predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const snapshot = await sync(port, ownerId);
      const match = predicate(snapshot);
      if (match) return { snapshot, match };
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

function eventsFor(snapshot, operationId) {
  return snapshot.events.filter((record) => record.runId === operationId);
}

function startRunner(port, dataDir, delayMs = 0) {
  return spawnNode("source/box-exec-daemon/server.mjs", {
    FABUSHI_RUNNER_PORT: String(port),
    FABUSHI_RUNNER_DATA_DIR: dataDir,
    FABUSHI_RUNNER_TEST_DELAY_MS: String(delayMs),
  });
}

function startHost(port, runnerPort, dataDir, stepDelayMs = 0) {
  return spawnNode("source/host/server.mjs", {
    FABUSHI_HOST_PORT: String(port),
    FABUSHI_RUNNER_URL: `http://127.0.0.1:${runnerPort}`,
    FABUSHI_HOST_DATA_DIR: dataDir,
    FABUSHI_HOST_TEST_PROVIDER: "deterministic",
    FABUSHI_HOST_TEST_STEP_DELAY_MS: String(stepDelayMs),
    FABUSHI_HOST_RECOVERY_ATTEMPTS: "12",
    FABUSHI_RUNNER_RECOVERY_ATTEMPTS: "12",
  });
}

function startCoordinator(port, hostPort, dataDir) {
  return spawnNode("source/mahayana-agent-coordinator/server.mjs", {
    FABUSHI_COORDINATOR_PORT: String(port),
    FABUSHI_HOST_URL: `http://127.0.0.1:${hostPort}`,
    FABUSHI_COORDINATOR_DATA_DIR: dataDir,
    FABUSHI_HOST_RECOVERY_ATTEMPTS: "12",
  });
}

async function assertSingleRunnerEffect(runnerDir, operationId) {
  const payload = JSON.parse(await readFile(path.join(runnerDir, "idempotency.json"), "utf8"));
  const keys = Object.keys(payload.results || {}).filter((key) => key.startsWith(`run:${operationId}:generation:1:tool:`));
  assert.equal(keys.length, 1, `expected exactly one persisted tool side effect, got ${keys.join(", ")}`);
}

async function runCrashScenario({
  name,
  basePort,
  crashTarget,
  hostDelayMs = 0,
  runnerDelayMs = 0,
}) {
  await test(name, { timeout: 45_000 }, async (t) => {
    const data = await mkdtemp(path.join(os.tmpdir(), "fabushi-web-crash-"));
    const dirs = {
      runner: path.join(data, "runner"),
      host: path.join(data, "host"),
      coordinator: path.join(data, "coordinator"),
    };
    const ports = { runner: basePort, host: basePort + 1, coordinator: basePort + 2 };
    let runner = startRunner(ports.runner, dirs.runner, runnerDelayMs);
    let host = startHost(ports.host, ports.runner, dirs.host, hostDelayMs);
    let coordinator = startCoordinator(ports.coordinator, ports.host, dirs.coordinator);

    t.after(async () => {
      await Promise.all([stopChild(coordinator), stopChild(host), stopChild(runner)]);
      await rm(data, { recursive: true, force: true });
    });

    await Promise.all([
      waitHealth(`http://127.0.0.1:${ports.runner}/healthz`),
      waitHealth(`http://127.0.0.1:${ports.host}/healthz`),
      waitHealth(`http://127.0.0.1:${ports.coordinator}/healthz`),
    ]);

    const owner = `owner-${crashTarget}`;
    const accepted = await requestCoordinator(ports.coordinator, owner, "runtime.execute", {
      command: {
        type: "chat.send",
        requestId: `crash-${crashTarget}-request`,
        text: "Inspect runtime capabilities with the runtime tool and then answer.",
        agentId: "assistant",
      },
    });
    const operationId = accepted.operationId;
    assert.ok(operationId);

    await waitSnapshot(
      ports.coordinator,
      owner,
      (snapshot) => eventsFor(snapshot, operationId).find((record) =>
        record.event?.type === "agent.step" &&
        record.event?.kind === "tool" &&
        record.event?.status === "running"
      ),
      `${crashTarget} tool-running state`,
    );

    if (crashTarget === "host") {
      await stopChild(host, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 350));
      host = startHost(ports.host, ports.runner, dirs.host, 0);
      await waitHealth(`http://127.0.0.1:${ports.host}/healthz`);
    } else if (crashTarget === "coordinator") {
      await stopChild(coordinator, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 350));
      coordinator = startCoordinator(ports.coordinator, ports.host, dirs.coordinator);
      await waitHealth(`http://127.0.0.1:${ports.coordinator}/healthz`);
    } else if (crashTarget === "runner") {
      await stopChild(runner, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 350));
      runner = startRunner(ports.runner, dirs.runner, 0);
      await waitHealth(`http://127.0.0.1:${ports.runner}/healthz`);
    } else {
      throw new Error(`Unknown crash target: ${crashTarget}`);
    }

    const finished = await waitSnapshot(
      ports.coordinator,
      owner,
      (snapshot) => {
        const run = snapshot.activeRuns.find((item) => item.operationId === operationId);
        const records = eventsFor(snapshot, operationId);
        const completed = records.filter((record) => record.event?.type === "operation.completed");
        return !run && completed.length === 1 ? records : null;
      },
      `${crashTarget} durable completion after restart`,
      30_000,
    );

    const records = finished.match;
    assert.equal(records.filter((record) => record.event?.type === "operation.started").length, 1);
    assert.equal(records.filter((record) => record.event?.type === "operation.completed").length, 1);
    assert.equal(records.filter((record) => record.event?.type === "operation.failed").length, 0);
    assert.equal(records.filter((record) => record.event?.type === "chat.message" && record.event?.role === "assistant").length, 1);
    await assertSingleRunnerEffect(dirs.runner, operationId);
  });
}

await runCrashScenario({
  name: "Host crash during tool execution resumes the same durable run without duplicate tool effects",
  basePort: 19410,
  crashTarget: "host",
  hostDelayMs: 3500,
});

await runCrashScenario({
  name: "Coordinator crash during tool execution reattaches to the same Host run",
  basePort: 19420,
  crashTarget: "coordinator",
  hostDelayMs: 3500,
});

await runCrashScenario({
  name: "Runner crash during tool execution is retried with the same idempotency key",
  basePort: 19430,
  crashTarget: "runner",
  runnerDelayMs: 3500,
});

test("Host rejects a stale generation instead of executing it", { timeout: 20_000 }, async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), "fabushi-web-stale-generation-"));
  const port = 19441;
  const host = startHost(port, 19440, path.join(data, "host"), 0);
  t.after(async () => {
    await stopChild(host);
    await rm(data, { recursive: true, force: true });
  });
  await waitHealth(`http://127.0.0.1:${port}/healthz`);

  const runId = "00000000-0000-4000-8000-000000000777";
  const bodyFor = (generation) => ({
    runId,
    executionKey: `run:${runId}:generation:${generation}`,
    ownerId: "stale-owner",
    conversationId: "mahayana-ai:agent:assistant",
    agentId: "assistant",
    text: "Answer without tools.",
  });

  const generation2 = await fetch(`http://127.0.0.1:${port}/v1/turn`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(bodyFor(2)),
  });
  const generation2Text = await generation2.text();
  assert.match(generation2Text, /operation\.completed/);

  const stale = await fetch(`http://127.0.0.1:${port}/v1/turn`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(bodyFor(1)),
  });
  const staleText = await stale.text();
  assert.match(staleText, /STALE_GENERATION/);
  assert.doesNotMatch(staleText, /operation\.completed/);
});
