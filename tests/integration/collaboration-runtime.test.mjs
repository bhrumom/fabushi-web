import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const ports = { host: 18950, coordinator: 18951 };

function startNode(script, env, children) {
  const child = spawn(process.execPath, [path.join(root, script)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  children.push(child);
}
async function waitHealth(url) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Health check failed: ${url}`);
}
async function coordinator(ownerId, method, args = {}) {
  const response = await fetch(`http://127.0.0.1:${ports.coordinator}/v1/request`, {
    method: "POST",
    headers: {
      authorization: "Bearer collaboration-token",
      "x-fabushi-owner": ownerId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ method, args }),
  });
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.result;
}
async function execute(ownerId, command) {
  return await coordinator(ownerId, "runtime.execute", { command });
}
async function sync(ownerId) {
  return await coordinator(ownerId, "runtime.resync", { afterSeq: 0 });
}
async function waitUntil(ownerId, predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await sync(ownerId);
    const match = predicate(snapshot);
    if (match) return { snapshot, match };
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function eventsOf(snapshot, type) {
  return snapshot.events.filter((record) => record.event?.type === type).map((record) => record.event);
}

test("agent peer, group, and broadcast collaboration use durable Host runs", { timeout: 35_000 }, async (t) => {
  const children = [];
  const data = await mkdtemp(path.join(os.tmpdir(), "fabushi-web-collaboration-"));
  t.after(async () => {
    await Promise.all(children.map((child) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      child.once("exit", resolve);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      }, 1500).unref();
    })));
    await rm(data, { recursive: true, force: true });
  });
  const common = { NODE_ENV: "test", FABUSHI_INTERNAL_TOKEN: "collaboration-token" };
  startNode("source/host/server.mjs", {
    ...common,
    FABUSHI_HOST_PORT: String(ports.host),
    FABUSHI_HOST_DATA_DIR: path.join(data, "host"),
    FABUSHI_HOST_TEST_PROVIDER: "deterministic",
    FABUSHI_HOST_TEST_STEP_DELAY_MS: "30",
  }, children);
  startNode("source/mahayana-agent-coordinator/server.mjs", {
    ...common,
    FABUSHI_COORDINATOR_PORT: String(ports.coordinator),
    FABUSHI_HOST_URL: `http://127.0.0.1:${ports.host}`,
    FABUSHI_COORDINATOR_DATA_DIR: path.join(data, "coordinator"),
  }, children);
  await Promise.all([
    waitHealth(`http://127.0.0.1:${ports.host}/healthz`),
    waitHealth(`http://127.0.0.1:${ports.coordinator}/healthz`),
  ]);

  await execute("owner-a", { type: "bot.create", requestId: "bot-one", name: "Planner", description: "plans", title: "Planner" });
  const planner = eventsOf(await sync("owner-a"), "bot.changed").at(-1).bot;
  await execute("owner-a", { type: "bot.create", requestId: "bot-two", name: "Reviewer", description: "reviews", title: "Reviewer" });
  const reviewer = eventsOf(await sync("owner-a"), "bot.changed").at(-1).bot;

  const peerAccepted = await execute("owner-a", {
    type: "agent.send",
    requestId: "peer-send-1",
    fromAgentId: planner.id,
    targetId: reviewer.id,
    text: "Review the launch plan and answer with a concise assessment.",
    priority: true,
  });
  assert.ok(peerAccepted.operationId);

  const peerDone = await waitUntil(
    "owner-a",
    (snapshot) => eventsOf(snapshot, "agent.backgroundFinished").find((event) => event.operationId === peerAccepted.operationId),
    "peer background completion",
  );
  assert.ok(eventsOf(peerDone.snapshot, "agent.backgroundStarted").some((event) => event.agentId === reviewer.id));
  assert.ok(eventsOf(peerDone.snapshot, "agent.backgroundDelta").some((event) => event.operationId === peerAccepted.operationId));
  assert.ok(eventsOf(peerDone.snapshot, "agent.backgroundMessage").some((event) => event.operationId === peerAccepted.operationId));

  await execute("owner-a", { type: "agent.peerHistory", requestId: "peer-history", agentId: planner.id, limit: 20 });
  const history = eventsOf(await sync("owner-a"), "agent.peerHistory").at(-1).messages;
  assert.ok(history.some((message) => message.fromAgentId === planner.id && message.targetId === reviewer.id && message.priority));
  assert.ok(history.some((message) => message.fromAgentId === reviewer.id && message.targetId === planner.id));

  await execute("owner-a", {
    type: "group.create",
    requestId: "group-create",
    name: "Launch Council",
    description: "Planner and reviewer",
    memberIds: [planner.id, reviewer.id],
  });
  const group = eventsOf(await sync("owner-a"), "group.changed").at(-1).group;

  await execute("owner-a", {
    type: "group.send",
    requestId: "group-send",
    id: group.id,
    text: "Each member give one final recommendation.",
  });

  const groupDone = await waitUntil(
    "owner-a",
    (snapshot) => {
      const messages = eventsOf(snapshot, "group.changed")
        .filter((event) => event.group.id === group.id && event.action === "message")
        .at(-1)?.group?.messages ?? [];
      const memberMessages = messages.filter((message) => message.speaker?.kind === "member");
      return memberMessages.length >= 2 ? memberMessages : null;
    },
    "two group member responses",
    12_000,
  );
  assert.ok(eventsOf(groupDone.snapshot, "group.delta").some((event) => event.groupId === group.id && event.memberId === planner.id));
  assert.ok(eventsOf(groupDone.snapshot, "group.delta").some((event) => event.groupId === group.id && event.memberId === reviewer.id));
  assert.equal(groupDone.match.length, 2);

  await execute("owner-a", {
    type: "agent.broadcast",
    requestId: "broadcast-one",
    targetIds: [planner.id, reviewer.id],
    message: "Acknowledge the release freeze.",
  });
  const broadcastSnapshot = await waitUntil(
    "owner-a",
    (snapshot) => eventsOf(snapshot, "agent.broadcasted").at(-1),
    "broadcast scheduling",
  );
  assert.deepEqual(broadcastSnapshot.match.result, { total: 2, scheduled: 2 });

  const backgroundStarts = eventsOf(broadcastSnapshot.snapshot, "agent.backgroundStarted")
    .filter((event) => event.source === "broadcast:user");
  assert.equal(new Set(backgroundStarts.map((event) => event.agentId)).size, 2);
});
