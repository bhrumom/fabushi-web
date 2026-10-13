import assert from "node:assert/strict";
import worker from "../../../official-site-worker.js";

const assets = new Map([
  ["/index.html", "OFFICIAL HOME"],
  ["/web/index.html", "WEB APPLICATION"],
  ["/download/index.html", "DOWNLOAD"],
  ["/_next/static/app.js", "SCRIPT"],
]);
const requests = [];
const env = { ASSETS: { async fetch(request) {
  const path = new URL(request.url).pathname;
  requests.push(path);
  return new Response(assets.get(path) ?? "NOT FOUND", { status: assets.has(path) ? 200 : 404 });
}}};
async function check(url, status, body) {
  const response = await worker.fetch(new Request(url), env);
  assert.equal(response.status, status, url);
  assert.equal(await response.text(), body, url);
}
async function redirect(url, location) {
  const response = await worker.fetch(new Request(url), env);
  assert.equal(response.status, 308, url);
  assert.equal(response.headers.get("location"), location, url);
}
await check("https://ombhrum.com/", 200, "OFFICIAL HOME");
await check("https://web.ombhrum.com/", 200, "WEB APPLICATION");
await check("https://web.ombhrum.com/index.html", 200, "WEB APPLICATION");
await check("https://ombhrum.com/download/", 200, "DOWNLOAD");
await check("https://web.ombhrum.com/_next/static/app.js", 200, "SCRIPT");
await check("https://ombhrum.com/missing/", 404, "NOT FOUND");
await redirect("https://ombhrum.com/index.html?utm_source=test", "https://ombhrum.com/?utm_source=test");
await redirect("https://ombhrum.com/download/index.html", "https://ombhrum.com/download/");
await redirect("https://ombhrum.com/download?channel=stable", "https://ombhrum.com/download/?channel=stable");
await redirect("https://web.ombhrum.com/web/?from=legacy", "https://web.ombhrum.com/?from=legacy");
await redirect("http://web.ombhrum.com/", "https://web.ombhrum.com/");
await redirect("http://ombhrum.com/", "https://ombhrum.com/");
for (const host of ["www.ombhrum.com", "fabushi.ombhrum.com"]) {
  await redirect("https://" + host + "/download/?channel=stable", "https://ombhrum.com/download/?channel=stable");
}
assert.ok(requests.includes("/web/index.html"));
assert.equal(requests.filter(x => x === "/web/").length, 0);
console.log("Official site/Web host split checks passed.");
