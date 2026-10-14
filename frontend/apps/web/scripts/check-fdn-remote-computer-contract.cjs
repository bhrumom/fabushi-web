#!/usr/bin/env node
const fs = require("node:fs");
const assert = require("node:assert/strict");

const sourcePath = "src/lib/remote-computer/remote-api.ts";
const source = fs.readFileSync(sourcePath, "utf8");

function requires(fragment, message) {
  assert.ok(source.includes(fragment), message + ": " + fragment);
}

requires('const CONTROL_SESSION_REQUEST_KEY_PREFIX = "fabushi-remote-control-session-request-v1";', "missing scoped request-id namespace");
requires("function controlSessionRequestStorageKey(", "missing scoped request-id key owner");
requires("accountStorageScope(userId)", "request-id key must be account scoped");
requires("deviceId", "request-id key must bind device");
requires("clientId", "request-id key must bind client");
requires("function stableControlSessionRequestId(", "missing stable request-id owner");
requires('const existing = storage.getItem(key)?.trim() ?? "";', "existing pending request must be reused");
requires('const requestId = newId("mobile-request");', "new request identity must be bounded opaque id");
requires("storage.setItem(key, requestId);", "new request identity must be persisted before send");
requires("if (storage.getItem(key) !== requestId)", "request identity must round-trip before send");
requires("function clearControlSessionRequestId(", "missing success-only pending-id cleanup");
requires("if (storage.getItem(key) === requestId) storage.removeItem(key);", "cleanup must only remove matching request");
requires("const requestId = stableControlSessionRequestId(userId, deviceId, clientId);", "session create must claim stable request identity");
requires("body: JSON.stringify({ clientId, clientToken, requestId }),", "session create must send requestId");
requires("accountIdentity(this.session.userId) !== accountIdentity(userId)", "in-flight result must be account fenced");
requires("clearControlSessionRequestId(userId, deviceId, clientId, requestId);", "request identity must clear after validated success");

const createStart = source.indexOf("async createControlSession(");
const signalStart = source.indexOf("\n  async signal(", createStart);
assert.ok(createStart >= 0 && signalStart > createStart, "createControlSession body not found");
const createBody = source.slice(createStart, signalStart);
const validation = createBody.indexOf("const raw = await parseResponse<unknown>(response);");
const accountFence = createBody.indexOf("accountIdentity(this.session.userId) !== accountIdentity(userId)");
const clear = createBody.indexOf("clearControlSessionRequestId(userId, deviceId, clientId, requestId);");
assert.ok(validation >= 0 && accountFence > validation && clear > accountFence,
  "pending request identity must clear only after response validation and account fence");

for (const forbidden of [
  "console.log(clientToken",
  "console.info(clientToken",
  "console.warn(clientToken",
  "console.error(clientToken",
  "encodeURIComponent(clientToken)",
  "clientToken=",
  "mobileToken=",
  "accessToken=",
  "refreshToken=",
]) {
  assert.ok(!source.includes(forbidden), "credential leakage pattern present: " + forbidden);
}

console.log("FDN G13 Web Remote Computer contract: passed");
