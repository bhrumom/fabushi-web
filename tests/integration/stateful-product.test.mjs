import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const ports = { host: 18940, coordinator: 18941 };

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
async function coordinator(ownerId, method, args = {}) {
  const response = await fetch(`http://127.0.0.1:${ports.coordinator}/v1/request`, {
    method: "POST",
    headers: {
      authorization: "Bearer stateful-internal-token",
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
async function events(ownerId) {
  return (await coordinator(ownerId, "runtime.resync", { afterSeq: 0 })).events;
}
async function eventOf(ownerId, type) {
  const matches = (await events(ownerId)).filter((record) => record.event?.type === type);
  assert.ok(matches.length, `missing event ${type}`);
  return matches.at(-1).event;
}

test("Host stateful product domains persist per owner without cross-tenant leakage", { timeout: 30_000 }, async (t) => {
  const children = [];
  const data = await mkdtemp(path.join(os.tmpdir(), "fabushi-web-stateful-"));
  t.after(async () => {
    for (const child of children) child.kill("SIGTERM");
    await rm(data, { recursive: true, force: true });
  });
  const common = { NODE_ENV: "test", FABUSHI_INTERNAL_TOKEN: "stateful-internal-token" };
  startNode("source/host/server.mjs", {
    ...common,
    FABUSHI_HOST_PORT: String(ports.host),
    FABUSHI_HOST_DATA_DIR: path.join(data, "host"),
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

  await execute("owner-a", { type: "settings.get", requestId: "settings-get-a" });
  const initialSettings = await eventOf("owner-a", "settings.changed");
  assert.equal(initialSettings.settings.notifications, true);
  await execute("owner-a", {
    type: "settings.update",
    requestId: "settings-update-a",
    settings: {
      ...initialSettings.settings,
      notifications: false,
      inferenceProvider: "openrouter",
      localToolPermission: "always",
    },
  });
  const updatedSettings = await eventOf("owner-a", "settings.changed");
  assert.equal(updatedSettings.settings.notifications, false);
  assert.equal(updatedSettings.settings.inferenceProvider, "openrouter");

  await execute("owner-b", { type: "settings.get", requestId: "settings-get-b" });
  const ownerBSettings = await eventOf("owner-b", "settings.changed");
  assert.equal(ownerBSettings.settings.notifications, true);
  assert.equal(ownerBSettings.settings.inferenceProvider, "fabushi");

  await execute("owner-a", {
    type: "bot.create",
    requestId: "bot-create",
    name: "Researcher",
    description: "Private research agent",
    title: "Research",
  });
  const createdBot = (await eventOf("owner-a", "bot.changed")).bot;
  assert.match(createdBot.id, /^agent-/);
  await execute("owner-a", { type: "bot.setHidden", requestId: "bot-hide", id: createdBot.id, hidden: true });
  const hiddenBot = (await eventOf("owner-a", "bot.changed")).bot;
  assert.equal(hiddenBot.hidden, true);
  await execute("owner-a", { type: "bot.list", requestId: "bot-list-a" });
  const botsA = (await eventOf("owner-a", "bot.listed")).bots;
  assert.ok(botsA.some((bot) => bot.id === createdBot.id && bot.hidden));
  await execute("owner-b", { type: "bot.list", requestId: "bot-list-b" });
  const botsB = (await eventOf("owner-b", "bot.listed")).bots;
  assert.deepEqual(botsB.map((bot) => bot.id), ["assistant"]);

  await execute("owner-a", {
    type: "group.create",
    requestId: "group-create",
    name: "Private Team",
    description: "Only owner A",
    memberIds: ["assistant", createdBot.id],
  });
  const createdGroup = (await eventOf("owner-a", "group.changed")).group;
  await execute("owner-a", {
    type: "group.update",
    requestId: "group-update",
    id: createdGroup.id,
    name: "Renamed Team",
  });
  assert.equal((await eventOf("owner-a", "group.changed")).group.name, "Renamed Team");
  await execute("owner-b", { type: "group.list", requestId: "group-list-b" });
  assert.deepEqual((await eventOf("owner-b", "group.listed")).groups, []);

  await execute("owner-a", {
    type: "skill.upsert",
    requestId: "skill-create",
    name: "Private Skill",
    description: "Owner A only",
    useWhen: "testing stateful parity",
    instructions: "Return the private marker.",
    ownerAgentId: createdBot.id,
  });
  const skill = (await eventOf("owner-a", "skill.changed")).skill;
  assert.equal(skill.source, "private");
  await execute("owner-a", { type: "skill.list", requestId: "skill-list-a", agentId: createdBot.id });
  assert.ok((await eventOf("owner-a", "skill.listed")).skills.some((item) => item.id === skill.id));
  await execute("owner-b", { type: "skill.list", requestId: "skill-list-b" });
  assert.deepEqual((await eventOf("owner-b", "skill.listed")).skills, []);

  await execute("owner-a", {
    type: "memory.add",
    requestId: "memory-add",
    agentId: createdBot.id,
    content: "owner-a-memory-marker",
    kind: "profile",
  });
  const memory = (await eventOf("owner-a", "memory.changed")).memory;
  await execute("owner-a", { type: "memory.list", requestId: "memory-list-a", agentId: createdBot.id, limit: 20 });
  assert.ok((await eventOf("owner-a", "memory.listed")).memories.some((item) => item.id === memory.id));
  await execute("owner-b", { type: "memory.list", requestId: "memory-list-b", agentId: createdBot.id, limit: 20 });
  assert.deepEqual((await eventOf("owner-b", "memory.listed")).memories, []);

  await execute("owner-a", { type: "tray.list", requestId: "tray-list-a" });
  assert.deepEqual((await eventOf("owner-a", "tray.listed")).trays, []);
  await execute("owner-a", { type: "tray.dismiss", requestId: "tray-dismiss", id: "missing-tray" });
  assert.equal((await eventOf("owner-a", "tray.changed")).action, "dismissed");

  await execute("owner-a", { type: "memory.remove", requestId: "memory-remove", agentId: createdBot.id, id: memory.id });
  assert.equal((await eventOf("owner-a", "memory.changed")).action, "removed");
  await execute("owner-a", { type: "skill.delete", requestId: "skill-delete", id: skill.id });
  assert.equal((await eventOf("owner-a", "skill.changed")).action, "deleted");
  await execute("owner-a", { type: "group.delete", requestId: "group-delete", id: createdGroup.id });
  assert.equal((await eventOf("owner-a", "group.changed")).action, "deleted");
  await execute("owner-a", { type: "bot.delete", requestId: "bot-delete", id: createdBot.id });
  assert.equal((await eventOf("owner-a", "bot.changed")).action, "deleted");
});
