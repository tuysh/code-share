import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './errors.js';
import { uniquePath } from './paths.js';

// No look-alike characters (0/O, 1/l/I) so links are easy to read aloud.
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ID_RE = /^[a-zA-Z0-9]{4,32}$/;
export const EDIT_MODES = ['owner', 'anyone'];

const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

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

/** Projects written before editing existed stored files by array index and had no owner. */
function normalize(meta) {
  if (!meta.editMode) meta.editMode = 'owner';
  if (meta.rev === undefined) meta.rev = 1;
  meta.files = meta.files.map((f, n) => ({
    ...f,
    id: f.id ?? String(n),
    version: f.version ?? 1,
    updatedAt: f.updatedAt ?? meta.createdAt,
  }));
  if (meta.nextFileId === undefined) meta.nextFileId = meta.files.length;
  return meta;
}

export class Store {
  constructor({ dataDir, ttlMs, idLength, maxFiles, maxFileSize, maxTotalSize }) {
    this.ttlMs = ttlMs;
    this.idLength = idLength;
    this.limits = { maxFiles, maxFileSize, maxTotalSize };
    this.projectsDir = path.join(dataDir, 'projects');
    this.tmpDir = path.join(dataDir, 'tmp');
    /** id -> expiresAt (ms). Source of truth for expiry sweeps. */
    this.index = new Map();
    /** id -> tail of that project's write queue, so edits never race on meta.json. */
    this.locks = new Map();
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

  filePath(id, fileId) {
    return path.join(this.projectDir(id), 'files', fileId);
  }

  newId() {
    for (;;) {
      let id = '';
      for (let i = 0; i < this.idLength; i++) id += ALPHABET[crypto.randomInt(ALPHABET.length)];
      if (!this.index.has(id) && !existsSync(this.projectDir(id))) return id;
    }
  }

  async writeMeta(meta) {
    const tmp = path.join(this.projectDir(meta.id), 'meta.json.tmp');
    await fs.writeFile(tmp, JSON.stringify(meta));
    await fs.rename(tmp, this.metaPath(meta.id));
  }

  withLock(id, fn) {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(id, tail);
    tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  /** Moves uploaded temp files into the project and appends them to `meta.files`. */
  async ingest(meta, files) {
    const taken = new Set(meta.files.map((f) => f.path));
    const now = Date.now();
    for (const file of files) {
      const fileId = String(meta.nextFileId++);
      const dest = this.filePath(meta.id, fileId);
      await fs.rename(file.tmpPath, dest);
      const p = uniquePath(file.path, taken);
      taken.add(p);
      meta.files.push({ id: fileId, path: p, size: file.size, binary: await isBinary(dest), version: 1, updatedAt: now });
    }
  }

  checkTotals(files) {
    if (files.length > this.limits.maxFiles) {
      throw new HttpError(413, `Un proyecto puede tener como máximo ${this.limits.maxFiles} archivos.`);
    }
    const total = files.reduce((sum, f) => sum + f.size, 0);
    if (total > this.limits.maxTotalSize) {
      throw new HttpError(413, `El proyecto puede pesar como máximo ${mb(this.limits.maxTotalSize)}.`);
    }
  }

  /**
   * @param files Array<{ tmpPath: string, path: string, size: number }>
   * @returns {{ meta: object, editToken: string }}
   */
  async create(files, { editMode = 'owner' } = {}) {
    this.checkTotals(files);
    const id = this.newId();
    const dir = this.projectDir(id);
    await fs.mkdir(path.join(dir, 'files'), { recursive: true });

    try {
      const editToken = crypto.randomBytes(24).toString('base64url');
      const createdAt = Date.now();
      const meta = {
        id,
        createdAt,
        expiresAt: createdAt + this.ttlMs,
        editMode: EDIT_MODES.includes(editMode) ? editMode : 'owner',
        tokenHash: hashToken(editToken),
        rev: 1,
        nextFileId: 0,
        files: [],
      };
      await this.ingest(meta, files);
      await this.writeMeta(meta);
      this.index.set(id, meta.expiresAt);
      return { meta, editToken };
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
      return normalize(JSON.parse(await fs.readFile(this.metaPath(id), 'utf8')));
    } catch {
      return null;
    }
  }

  isOwner(meta, token) {
    if (!meta.tokenHash || typeof token !== 'string' || !token) return false;
    const a = Buffer.from(meta.tokenHash, 'hex');
    const b = Buffer.from(hashToken(token), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  canEdit(meta, token) {
    return meta.editMode === 'anyone' || this.isOwner(meta, token);
  }

  /** Runs `fn(meta)` under the project lock, then persists meta with a bumped revision. */
  mutate(id, fn) {
    return this.withLock(id, async () => {
      const meta = await this.get(id);
      if (!meta) throw new HttpError(404, 'Este proyecto no existe o ya expiró.');
      const result = await fn(meta);
      meta.rev++;
      await this.writeMeta(meta);
      return result ?? meta;
    });
  }

  findFile(meta, fileId) {
    const file = meta.files.find((f) => f.id === fileId);
    if (!file) throw new HttpError(404, 'Archivo no encontrado.');
    return file;
  }

  addFiles(id, files) {
    return this.mutate(id, async (meta) => {
      this.checkTotals([...meta.files, ...files]);
      const before = meta.files.length;
      await this.ingest(meta, files);
      return { meta, added: meta.files.slice(before) };
    });
  }

  /** Replaces a file's content. `baseVersion` (optional) guards against overwriting someone else's save. */
  updateFile(id, fileId, content, baseVersion) {
    return this.mutate(id, async (meta) => {
      const file = this.findFile(meta, fileId);
      if (baseVersion !== undefined && baseVersion !== file.version) {
        throw new HttpError(409, 'Otra persona guardó cambios en este archivo mientras lo editabas.');
      }
      if (content.length > this.limits.maxFileSize) {
        throw new HttpError(413, `Cada archivo puede pesar como máximo ${mb(this.limits.maxFileSize)}.`);
      }
      const others = meta.files.filter((f) => f !== file);
      this.checkTotals([...others, { size: content.length }]);

      const dest = this.filePath(id, fileId);
      const tmp = `${dest}.tmp`;
      await fs.writeFile(tmp, content);
      await fs.rename(tmp, dest);
      file.size = content.length;
      file.binary = content.subarray(0, 8000).includes(0);
      file.version++;
      file.updatedAt = Date.now();
      return { meta, file };
    });
  }

  renameFile(id, fileId, newPath) {
    return this.mutate(id, async (meta) => {
      const file = this.findFile(meta, fileId);
      if (meta.files.some((f) => f !== file && f.path === newPath)) {
        throw new HttpError(409, 'Ya existe un archivo con ese nombre.');
      }
      file.path = newPath;
      file.updatedAt = Date.now();
      return { meta, file };
    });
  }

  deleteFile(id, fileId) {
    return this.mutate(id, async (meta) => {
      const file = this.findFile(meta, fileId);
      if (meta.files.length === 1) {
        throw new HttpError(400, 'Un proyecto necesita al menos un archivo. Elimina el proyecto completo en su lugar.');
      }
      meta.files = meta.files.filter((f) => f !== file);
      await fs.rm(this.filePath(id, fileId), { force: true });
      return meta;
    });
  }

  setEditMode(id, editMode) {
    if (!EDIT_MODES.includes(editMode)) throw new HttpError(400, 'Modo de edición inválido.');
    return this.mutate(id, async (meta) => {
      meta.editMode = editMode;
      return meta;
    });
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
        await this.withLock(id, () => this.remove(id));
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
