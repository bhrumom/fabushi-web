import os from 'node:os';
import path from 'node:path';
import { AtomicJsonStore } from '../shared/atomic-json-store.mjs';
import { ProtocolError, asRecord, nowIso, requireString } from '../shared/protocol.mjs';

export class SafeRunner {
  constructor({ dataDir = process.env.FABUSHI_RUNNER_DATA_DIR || path.resolve('.data/runner') } = {}) {
    this.results = new AtomicJsonStore(path.join(dataDir, 'idempotency.json'), () => ({ version: 1, results: {} }));
  }

  async execute(input) {
    const body = asRecord(input);
    if (!body) throw new ProtocolError('INVALID_ARGUMENT', 'Runner request must be an object');
    const idempotencyKey = requireString(body.idempotencyKey, 'idempotencyKey', { max: 256 });
    const tool = requireString(body.tool, 'tool', { max: 128 });
    const args = asRecord(body.args) ?? {};
    const existing = await this.results.read();
    if (existing.results[idempotencyKey]) return existing.results[idempotencyKey];
    const testDelayMs = Number(process.env.FABUSHI_RUNNER_TEST_DELAY_MS || 0);
    if (testDelayMs > 0 && process.env.NODE_ENV !== 'production') {
      await new Promise((resolve) => setTimeout(resolve, testDelayMs));
    }
    const result = await this.#runTool(tool, args);
    const record = { idempotencyKey, tool, ok: true, result, completedAt: nowIso() };
    await this.results.update((state) => { state.results[idempotencyKey] ??= record; return state.results[idempotencyKey]; });
    const latest = await this.results.read();
    return latest.results[idempotencyKey];
  }

  async #runTool(tool, args) {
    switch (tool) {
      case 'time.now': {
        const zone = typeof args.timeZone === 'string' && args.timeZone.length <= 80 ? args.timeZone : 'UTC';
        let formatted;
        try { formatted = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'long', timeZone: zone }).format(new Date()); }
        catch { throw new ProtocolError('INVALID_ARGUMENT', `Unsupported time zone: ${zone}`); }
        return { iso: nowIso(), timeZone: zone, formatted };
      }
      case 'runtime.capabilities':
        return { platform: process.platform, arch: process.arch, node: process.version, hostname: os.hostname(), tools: ['time.now', 'runtime.capabilities'] };
      default:
        throw new ProtocolError('TOOL_NOT_ALLOWED', `Runner tool is not allowlisted: ${tool}`);
    }
  }
}
