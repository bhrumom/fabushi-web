import fs from 'node:fs/promises';
import path from 'node:path';

const REFERENCE_REPOSITORY = 'b-nnett/grok-bot-0.18-reconstructed';
const REFERENCE_COMMIT = 'a9f633e09d49a85829b8236331b9e21f7e612634';
const MANIFEST_PATH = 'docs/architecture/grok-bot-0.18-web-parity-manifest.json';
const REQUIRED_FIELDS = [
  'source_path','source_blob_sha','source_area','source_kind','source_responsibility',
  'product_relevant','web_effect','platform_delta','target_path','related_target_paths',
  'target_language','runtime_owner','transport_boundary','status','behavior_contract',
  'replacement_behavior','tests','evidence','notes',
];
const ALLOWED_STATUSES = new Set(['planned','implementing','implemented','equivalent','not-applicable']);
const FINAL_STATUSES = new Set(['implemented','equivalent','not-applicable']);
const STRICT = process.argv.includes('--strict');
const PRODUCTION_ROOTS = [
  'source/web-main',
  'source/mahayana-agent-coordinator',
  'source/host',
  'source/box-exec-daemon',
  'frontend/apps/web/src',
];
const CODE_EXTENSIONS = new Set(['.js','.jsx','.mjs','.cjs','.ts','.tsx']);

function fail(message) { throw new Error(message); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function recordTargetPaths(record) {
  return [...new Set([record.target_path, ...(record.related_target_paths || [])].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}
async function pathExists(target) {
  try { await fs.stat(target); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}
async function walk(root) {
  const files = [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return files; throw error; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
if (manifest.reference?.repository !== REFERENCE_REPOSITORY) fail('manifest reference repository mismatch');
if (manifest.reference?.commit !== REFERENCE_COMMIT) fail('manifest reference commit mismatch');
if (!Array.isArray(manifest.records)) fail('manifest.records must be an array');
if (manifest.records.length !== 2111) fail(`expected 2111 records, found ${manifest.records.length}`);

const byPath = new Map();
for (const record of manifest.records) {
  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) fail(`${record.source_path ?? '<unknown>'}: missing ${field}`);
  }
  if (typeof record.source_path !== 'string' || !record.source_path) fail('invalid source_path');
  if (byPath.has(record.source_path)) fail(`duplicate source_path: ${record.source_path}`);
  byPath.set(record.source_path, record);
  if (!/^[0-9a-f]{40}$/i.test(record.source_blob_sha)) fail(`${record.source_path}: invalid source_blob_sha`);
  if (!ALLOWED_STATUSES.has(record.status)) fail(`${record.source_path}: invalid status ${record.status}`);
  if (!Array.isArray(record.related_target_paths) || !Array.isArray(record.tests) || !Array.isArray(record.evidence)) {
    fail(`${record.source_path}: related_target_paths/tests/evidence must be arrays`);
  }
  if (record.status === 'not-applicable' && !String(record.platform_delta || '').trim()) {
    fail(`${record.source_path}: not-applicable requires platform_delta`);
  }
  if (record.status === 'not-applicable' && record.product_relevant && !String(record.replacement_behavior || '').trim()) {
    fail(`${record.source_path}: product-relevant not-applicable requires replacement_behavior`);
  }
  if (FINAL_STATUSES.has(record.status) && (record.status === 'implemented' || record.status === 'equivalent')) {
    if ((!record.target_path && record.related_target_paths.length === 0) || record.evidence.length === 0) {
      fail(`${record.source_path}: final implementation status requires target path and evidence`);
    }
  }
  if (STRICT) {
    if (!FINAL_STATUSES.has(record.status)) fail(`${record.source_path}: strict mode forbids unresolved status ${record.status}`);
    if (!text(record.source_responsibility)) fail(`${record.source_path}: strict mode requires source_responsibility`);
    if (record.product_relevant && !text(record.web_effect)) fail(`${record.source_path}: product-relevant record requires web_effect`);
    if (record.status === 'implemented' || record.status === 'equivalent') {
      if (!text(record.target_language)) fail(`${record.source_path}: strict mode requires target_language`);
      if (!text(record.runtime_owner)) fail(`${record.source_path}: strict mode requires runtime_owner`);
      if (!text(record.behavior_contract)) fail(`${record.source_path}: strict mode requires behavior_contract`);
      if (record.tests.length === 0) fail(`${record.source_path}: strict mode requires behavioral/contract tests`);
      if (record.evidence.length === 0) fail(`${record.source_path}: strict mode requires evidence`);
    }
    if (record.status === 'not-applicable' && record.evidence.length === 0) {
      fail(`${record.source_path}: strict not-applicable requires reviewed evidence`);
    }
  }
}

if (process.argv.includes('--verify-reference')) {
  const url = `https://api.github.com/repos/${REFERENCE_REPOSITORY}/git/trees/${REFERENCE_COMMIT}?recursive=1`;
  const headers = { 'accept': 'application/vnd.github+json', 'user-agent': 'fabushi-web-parity-checker' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) fail(`reference tree fetch failed: HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.truncated) fail('reference tree response was truncated');
  const blobs = payload.tree.filter((entry) => entry.type === 'blob');
  if (blobs.length !== 2111) fail(`reference tree expected 2111 blobs, found ${blobs.length}`);
  const referencePaths = new Set(blobs.map((blob) => blob.path));
  for (const blob of blobs) {
    const record = byPath.get(blob.path);
    if (!record) fail(`reference file missing from manifest: ${blob.path}`);
    if (record.source_blob_sha !== blob.sha) fail(`blob sha mismatch: ${blob.path}`);
  }
  for (const path of byPath.keys()) {
    if (!referencePaths.has(path)) fail(`manifest contains non-reference file: ${path}`);
  }
}

if (STRICT) {
  for (const record of manifest.records) {
    if (record.status !== 'implemented' && record.status !== 'equivalent') continue;
    for (const target of recordTargetPaths(record)) {
      if (target.includes('*')) fail(`${record.source_path}: strict target paths must identify real files/directories, not globs: ${target}`);
      if (!await pathExists(target)) fail(`${record.source_path}: mapped target does not exist: ${target}`);
    }
  }

  const productionFiles = (await Promise.all(PRODUCTION_ROOTS.map(walk))).flat();
  for (const file of productionFiles) {
    const source = await fs.readFile(file, 'utf8');
    if (/\b(?:from\s*['\"]electron['\"]|require\(\s*['\"]electron['\"]\s*\))/.test(source)) {
      fail(`strict mode forbids Electron production dependency: ${file}`);
    }
  }
  const hostClient = 'frontend/apps/web/src/app/host/host-client.tsx';
  if (await pathExists(hostClient)) {
    const source = await fs.readFile(hostClient, 'utf8');
    for (const forbidden of ['electron-transport', 'wasm-transport']) {
      if (source.includes(forbidden)) fail(`strict mode forbids legacy Host fallback ${forbidden} in ${hostClient}`);
    }
    if (source.includes('mock-transport') && !source.includes('NEXT_PUBLIC_HOST_SCREENSHOT_MODE')) {
      fail(`strict mode allows Mock Host only behind the explicit screenshot/test gate in ${hostClient}`);
    }
  }
}

const counts = manifest.records.reduce((acc, record) => {
  acc[record.status] = (acc[record.status] || 0) + 1;
  return acc;
}, {});
console.log(JSON.stringify({ ok: true, strict: STRICT, reference: REFERENCE_COMMIT, records: manifest.records.length, statuses: counts }, null, 2));
