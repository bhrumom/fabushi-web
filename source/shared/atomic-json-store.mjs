import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class AtomicJsonStore {
  #queue = Promise.resolve();
  #loaded = false;
  #value;

  constructor(filePath, createInitial) {
    this.filePath = filePath;
    this.createInitial = createInitial;
  }

  async read() {
    await this.#ensureLoaded();
    return structuredClone(this.#value);
  }

  async update(mutator) {
    const work = this.#queue.then(async () => {
      await this.#ensureLoaded();
      const draft = structuredClone(this.#value);
      const result = await mutator(draft);
      await this.#persist(draft);
      this.#value = draft;
      return result;
    });
    this.#queue = work.catch(() => undefined);
    return await work;
  }

  async #ensureLoaded() {
    if (this.#loaded) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.#value = JSON.parse(raw);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#value = this.createInitial();
      await this.#persist(this.#value);
    }
    this.#loaded = true;
  }

  async #persist(value) {
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const body = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}
