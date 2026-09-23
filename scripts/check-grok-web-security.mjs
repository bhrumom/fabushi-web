import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const AGENT_SURFACE = [
  "frontend/apps/web/src/app/host/host-client.tsx",
  "frontend/apps/web/src/lib/mahayana-host/websocket-transport.ts",
  "frontend/apps/web/src/components/pwa-runtime.tsx",
];
const SECRET_ENV = /(?:FABUSHI_(?:INTERNAL_TOKEN|WEB_SESSION_SECRET|DEV_BEARER_TOKEN|AUTH_INTROSPECTION_URL)|NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY))/;
const BROWSER_SECRET_STORAGE = /(?:localStorage|sessionStorage)\.(?:setItem|getItem)\([^\n]*(?:secret|token|password|credential)/i;

function fail(message) { throw new Error(message); }

for (const relative of AGENT_SURFACE) {
  const source = await fs.readFile(path.join(ROOT, relative), "utf8");
  if (relative.endsWith("host-client.tsx")) {
    if (source.includes("electron-transport") || source.includes("ElectronMahayanaHostTransport")) fail("Web Host may not import Electron transport");
    if (source.includes("wasm-transport") || source.includes("WasmMahayanaHostTransport")) fail("Web Host may not fall back to WASM runtime");
    if (!source.includes("WebSocketMahayanaHostTransport")) fail("Web Host must use the typed WebSocket transport");
  }
  if (SECRET_ENV.test(source)) fail(`${relative}: server/provider secret environment variable is referenced by browser code`);
  if (BROWSER_SECRET_STORAGE.test(source)) fail(`${relative}: secret/token-like material is persisted in browser storage`);
}

const sw = await fs.readFile(path.join(ROOT, "frontend/apps/web/public/sw.js"), "utf8");
if (!sw.includes('requestUrl.pathname.startsWith("/v1/")')) fail("service worker must exclude /v1 runtime requests");
if (!sw.includes('request.method !== "GET"')) fail("service worker must never cache state-changing requests");
if (!sw.includes("CACHE_PREFIX")) fail("service worker cache must be versioned");
if (!sw.includes("SKIP_WAITING")) fail("service worker must support explicit update handoff");

const webMain = await fs.readFile(path.join(ROOT, "source/web-main/server.mjs"), "utf8");
if (!webMain.includes("process.env.NODE_ENV !== 'production'")) fail("development bearer bypass must be production-gated");
if (!webMain.includes("originAllowed")) fail("Web Main must enforce an origin allowlist");
if (!webMain.includes("sessionFromRequest")) fail("Web Main WebSocket must require an authenticated session");

console.log(JSON.stringify({ ok: true, checkedBrowserFiles: AGENT_SURFACE.length, pwaCacheBoundary: true, webMainBoundary: true }, null, 2));
