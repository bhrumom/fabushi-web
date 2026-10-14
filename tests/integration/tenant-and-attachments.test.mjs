import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const ports = { host: 18930, coordinator: 18931 };

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
async function coordinator(ownerId, method, args = {}, expectOk = true) {
  const response = await fetch(`http://127.0.0.1:${ports.coordinator}/v1/request`, {
    method: "POST",
    headers: {
      authorization: "Bearer tenant-internal-token",
      "x-fabushi-owner": ownerId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ method, args }),
  });
  const body = await response.json();
  if (expectOk) {
    assert.equal(response.ok, true, JSON.stringify(body));
    assert.equal(body.ok, true, JSON.stringify(body));
    return body.result;
  }
  assert.equal(response.ok, false);
  assert.equal(body.ok, undefined);
  assert.ok(body.error?.code);
  return body.error;
}
async function execute(ownerId, command, expectOk = true) {
  return await coordinator(ownerId, "runtime.execute", { command }, expectOk);
}
async function waitRun(ownerId, runId) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const run = await coordinator(ownerId, "runtime.run", { runId });
    if (["completed", "failed", "cancelled"].includes(run.state)) return run;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`Run did not settle: ${runId}`);
}
async function resync(ownerId) {
  return await coordinator(ownerId, "runtime.resync", { afterSeq: 0 });
}
function lastEvent(sync, type) {
  const events = sync.events.filter((record) => record.event?.type === type);
  assert.ok(events.length, `missing event ${type}`);
  return events.at(-1).event;
}

test("Coordinator isolates transcripts and Host isolates attachment content per owner", { timeout: 35_000 }, async (t) => {
  const children = [];
  const data = await mkdtemp(path.join(os.tmpdir(), "fabushi-web-tenant-"));
  t.after(async () => {
    for (const child of children) child.kill("SIGTERM");
    await rm(data, { recursive: true, force: true });
  });

  const common = { NODE_ENV: "test", FABUSHI_INTERNAL_TOKEN: "tenant-internal-token" };
  startNode("source/host/server.mjs", {
    ...common,
    FABUSHI_HOST_PORT: String(ports.host),
    FABUSHI_HOST_DATA_DIR: path.join(data, "host"),
    FABUSHI_HOST_TEST_PROVIDER: "deterministic",
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

  const sharedConversationId = "shared-conversation";
  const a = await execute("owner-a", {
    type: "chat.send",
    requestId: "a-turn",
    conversationId: sharedConversationId,
    agentId: "assistant",
    text: "alpha-only transcript marker",
  });
  const b = await execute("owner-b", {
    type: "chat.send",
    requestId: "b-turn",
    conversationId: sharedConversationId,
    agentId: "assistant",
    text: "beta-only transcript marker",
  });
  assert.equal((await waitRun("owner-a", a.operationId)).state, "completed");
  assert.equal((await waitRun("owner-b", b.operationId)).state, "completed");

  await execute("owner-a", { type: "conversation.open", requestId: "a-open", conversationId: sharedConversationId });
  const aOpen = lastEvent(await resync("owner-a"), "conversation.opened");
  assert.ok(aOpen.messages.some((message) => message.text.includes("alpha-only")));
  assert.equal(aOpen.messages.some((message) => message.text.includes("beta-only")), false);

  await execute("owner-b", { type: "conversation.open", requestId: "b-open", conversationId: sharedConversationId });
  const bOpen = lastEvent(await resync("owner-b"), "conversation.opened");
  assert.ok(bOpen.messages.some((message) => message.text.includes("beta-only")));
  assert.equal(bOpen.messages.some((message) => message.text.includes("alpha-only")), false);

  await execute("owner-a", { type: "search.messages", requestId: "a-search", query: "marker", limit: 20 });
  const aSearch = lastEvent(await resync("owner-a"), "search.messages");
  assert.ok(aSearch.matches.some((match) => match.snippet.includes("alpha-only")));
  assert.equal(aSearch.matches.some((match) => match.snippet.includes("beta-only")), false);

  const textBytes = Buffer.from("owner-a attachment secret", "utf8").toString("base64");
  await execute("owner-a", {
    type: "attachment.upload",
    requestId: "attachment-upload",
    agentId: "assistant",
    filename: "notes.txt",
    mimeType: "text/plain",
    bytesBase64: textBytes,
  });
  const stored = lastEvent(await resync("owner-a"), "attachment.stored").attachment;
  assert.match(stored.path, /^fabushi-attachment:\/\//);
  assert.equal(stored.name, "notes.txt");

  await execute("owner-a", {
    type: "attachment.readText",
    requestId: "attachment-read",
    agentId: "assistant",
    path: stored.path,
  });
  const text = lastEvent(await resync("owner-a"), "attachment.text");
  assert.equal(text.result.text, "owner-a attachment secret");

  const forbidden = await execute("owner-b", {
    type: "attachment.readText",
    requestId: "attachment-cross-owner",
    agentId: "assistant",
    path: stored.path,
  }, false);
  assert.equal(forbidden.code, "ATTACHMENT_NOT_FOUND");

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");
  await execute("owner-a", {
    type: "attachment.upload",
    requestId: "image-upload",
    agentId: "assistant",
    filename: "pixel.png",
    mimeType: "image/png",
    bytesBase64: png.toString("base64"),
  });
  const imageStored = lastEvent(await resync("owner-a"), "attachment.stored").attachment;

  await execute("owner-a", {
    type: "attachment.readImage",
    requestId: "image-read",
    agentId: "assistant",
    path: imageStored.path,
  });
  const image = lastEvent(await resync("owner-a"), "attachment.image");
  assert.match(image.result.dataUrl, /^data:image\/png;base64,/);

  await execute("owner-a", { type: "search.media", requestId: "media-search", query: "pixel", limit: 10 });
  const media = lastEvent(await resync("owner-a"), "search.media");
  assert.equal(media.matches[0].name, "pixel.png");
  assert.equal(media.matches[0].agentId, "assistant");
  assert.equal(typeof media.matches[0].sizeBytes, "number");
});
