import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// No look-alike characters (0/O, 1/l/I) so links are easy to read aloud.
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ID_RE = /^[a-zA-Z0-9]{4,32}$/;

async function isBinary(file) {
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(8000);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export class Store {
  constructor({ dataDir, ttlMs, idLength }) {
    this.ttlMs = ttlMs;
    this.idLength = idLength;
    this.projectsDir = path.join(dataDir, 'projects');
    this.tmpDir = path.join(dataDir, 'tmp');
    /** id -> expiresAt (ms). Source of truth for expiry sweeps. */
    this.index = new Map();
    this.timer = null;
  }

  async init() {
    await fs.rm(this.tmpDir, { recursive: true, force: true });
    await fs.mkdir(this.tmpDir, { recursive: true });
    await fs.mkdir(this.projectsDir, { recursive: true });

    for (const id of await fs.readdir(this.projectsDir)) {
      try {
        const meta = JSON.parse(await fs.readFile(this.metaPath(id), 'utf8'));
        this.index.set(id, meta.expiresAt);
      } catch {
        // Half-written or corrupt project: nothing can be served from it.
        await fs.rm(this.projectDir(id), { recursive: true, force: true });
      }
    }
    await this.sweep();
  }

  projectDir(id) {
    return path.join(this.projectsDir, id);
  }

  metaPath(id) {
    return path.join(this.projectDir(id), 'meta.json');
  }

  filePath(id, n) {
    return path.join(this.projectDir(id), 'files', String(n));
  }

  newId() {
    for (;;) {
      let id = '';
      for (let i = 0; i < this.idLength; i++) id += ALPHABET[crypto.randomInt(ALPHABET.length)];
      if (!this.index.has(id) && !existsSync(this.projectDir(id))) return id;
    }
  }

  /** @param files Array<{ tmpPath: string, path: string, size: number }> */
  async create(files) {
    const id = this.newId();
    const dir = this.projectDir(id);
    await fs.mkdir(path.join(dir, 'files'), { recursive: true });

    try {
      const entries = [];
      for (const [n, file] of files.entries()) {
        const dest = this.filePath(id, n);
        await fs.rename(file.tmpPath, dest);
        entries.push({ path: file.path, size: file.size, binary: await isBinary(dest) });
      }

      const createdAt = Date.now();
      const meta = { id, createdAt, expiresAt: createdAt + this.ttlMs, files: entries };
      const tmpMeta = path.join(dir, 'meta.json.tmp');
      await fs.writeFile(tmpMeta, JSON.stringify(meta));
      await fs.rename(tmpMeta, this.metaPath(id));
      this.index.set(id, meta.expiresAt);
      return meta;
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  async get(id) {
    if (!ID_RE.test(id) || !this.index.has(id)) return null;
    if (this.index.get(id) <= Date.now()) {
      await this.remove(id);
      return null;
    }
    try {
      return JSON.parse(await fs.readFile(this.metaPath(id), 'utf8'));
    } catch {
      return null;
    }
  }

  async remove(id) {
    this.index.delete(id);
    await fs.rm(this.projectDir(id), { recursive: true, force: true });
  }

  /** Deletes every project whose expiry has passed. Returns how many were removed. */
  async sweep(now = Date.now()) {
    let removed = 0;
    for (const [id, expiresAt] of this.index) {
      if (expiresAt <= now) {
        await this.remove(id);
        removed++;
      }
    }
    return removed;
  }

  startSweeper(intervalMs) {
    this.timer = setInterval(() => {
      this.sweep().catch((err) => console.error('sweep failed:', err));
    }, intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}
