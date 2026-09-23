import fs from 'node:fs/promises';

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

function fail(message) { throw new Error(message); }

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

const counts = manifest.records.reduce((acc, record) => {
  acc[record.status] = (acc[record.status] || 0) + 1;
  return acc;
}, {});
console.log(JSON.stringify({ ok: true, reference: REFERENCE_COMMIT, records: manifest.records.length, statuses: counts }, null, 2));
