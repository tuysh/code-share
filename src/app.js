import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, readdirSync, readFileSync } from 'node:fs';
import { pipeline, Transform } from 'node:stream';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import { ID_RE } from './store.js';
import { HttpError } from './errors.js';
import { sanitizePath, uniquePath, decodeFilename, PathSet, zipNames } from './paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = path.join(ROOT, 'views');
const PUBLIC = path.join(ROOT, 'public');
const HLJS = path.join(ROOT, 'node_modules', '@highlightjs', 'cdn-assets');
const HLJS_VERSION = JSON.parse(readFileSync(path.join(HLJS, 'package.json'), 'utf8')).version;

/** Short hash of every front-end file, so each deploy gets fresh asset URLs. */
function assetVersion() {
  const hash = crypto.createHash('sha256');
  const files = readdirSync(PUBLIC, { withFileTypes: true }).filter((e) => e.isFile());
  for (const { name } of files.sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(name).update(readFileSync(path.join(PUBLIC, name)));
  }
  return hash.digest('hex').slice(0, 10);
}

/**
 * Pages point at /assets/<version>/…. Module imports like `./common.js` resolve
 * relative to that URL, so a browser can never pair a new page with a cached old
 * script (which broke pages right after a deploy).
 */
function loadPages(version) {
  const render = (file) =>
    readFileSync(path.join(VIEWS, file), 'utf8')
      .replaceAll('"/assets/', `"/assets/${version}/`)
      .replaceAll('"/vendor/hljs/', `"/vendor/hljs/${HLJS_VERSION}/`);
  return { index: render('index.html'), project: render('project.html') };
}

// Raster images are safe to render inline; SVG is not (it can carry scripts).
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};

const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

/**
 * Rate-limit key for a client. IPv6 users typically get a whole /64 and can
 * rotate addresses inside it, so they are limited per /64.
 */
export function clientKey(ip = '') {
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const [head, tail] = ip.split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? null : tail ? tail.split(':') : [];
  const groups = t === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

const MAX_TRACKED_CLIENTS = 100_000;

function rateLimiter({ perHour, message }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, 10 * 60 * 1000);
  timer.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = clientKey(req.ip);
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      // Hard cap on memory: forget the oldest clients first (Maps keep insertion order).
      if (!entry && hits.size >= MAX_TRACKED_CLIENTS) hits.delete(hits.keys().next().value);
      entry = { count: 0, reset: now + 60 * 60 * 1000 };
      hits.delete(key);
      hits.set(key, entry);
    }
    if (++entry.count > perHour) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return next(new HttpError(429, message));
    }
    next();
  };
}

function contentDisposition(type, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  // toWellFormed: names stored by older versions may hold lone surrogates, which encodeURIComponent rejects.
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename.toWellFormed())}`;
}

const editToken = (req) => req.get('x-edit-token') || '';

export function createApp(config, store) {
  const app = express();
  app.disable('x-powered-by');
  // A hop count or address list, never `true`: that would take the client-supplied
  // left end of X-Forwarded-For as the IP and let anyone dodge the rate limits.
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);

  const baseUrl = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;

  const publicMeta = (meta, req, token = editToken(req)) => {
    return {
      id: meta.id,
      url: `${baseUrl(req)}/${meta.id}`,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      rev: meta.rev,
      editMode: meta.editMode,
      canEdit: store.canEdit(meta, token),
      isOwner: store.isOwner(meta, token),
      files: meta.files.map(({ id, path: p, size, binary, version, updatedAt }) => ({
        id,
        path: p,
        size,
        binary,
        version,
        updatedAt,
      })),
    };
  };

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': PAGE_CSP,
    });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  const version = assetVersion();
  const pages = loadPages(version);
  const sendPage = (res, name, status = 200) =>
    res.status(status).type('html').set('Cache-Control', 'no-cache').send(pages[name]);

  // Versioned URLs never change content, so they can be cached for good in production.
  // In development files change without a restart, so always revalidate.
  const versioned = config.production ? { immutable: true, maxAge: '1y' } : { maxAge: 0 };
  app.use(`/assets/${version}`, express.static(PUBLIC, versioned));
  // Unversioned paths remain for tabs opened before a deploy; never cache them.
  app.use('/assets', express.static(PUBLIC, { maxAge: 0 }));
  app.use(`/vendor/hljs/${HLJS_VERSION}`, express.static(HLJS, versioned));
  app.use('/vendor/hljs', express.static(HLJS, { maxAge: 0 }));
  app.get('/favicon.svg', (req, res) => res.sendFile(path.join(PUBLIC, 'favicon.svg')));
  app.get('/', (req, res) => sendPage(res, 'index'));

  app.get('/api/config', (req, res) => {
    res.json({
      ttlMs: config.ttlMs,
      maxFiles: config.maxFiles,
      maxFileSize: config.maxFileSize,
      maxTotalSize: config.maxTotalSize,
    });
  });

  // ---- Upload helpers -----------------------------------------------------

  const tooBig = () => new HttpError(413, `El proyecto puede pesar como máximo ${mb(config.maxTotalSize)}.`);
  const tooMany = () => new HttpError(413, `Un proyecto puede tener como máximo ${config.maxFiles} archivos.`);

  /**
   * Multer disk storage that also counts bytes across the whole request and stops
   * writing as soon as the request goes over `req.uploadBudget.bytes`. Multer only
   * limits each file, so without this a request could write maxFiles × maxFileSize
   * to disk before the project total was even checked.
   */
  const budgetStorage = {
    _handleFile(req, file, cb) {
      const dest = path.join(store.tmpDir, crypto.randomUUID());
      const out = createWriteStream(dest);
      const budget = req.uploadBudget;
      let size = 0;
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        if (!err) return cb(null, { path: dest, size });
        // Stop writing but keep reading (and discarding) the part, so multer can
        // finish parsing and answer with the error instead of a dropped connection.
        file.stream.unpipe(out);
        file.stream.resume();
        out.destroy();
        fs.rm(dest, { force: true }).finally(() => cb(err));
      };
      file.stream.on('data', (chunk) => {
        size += chunk.length;
        budget.used += chunk.length;
        if (budget.used > budget.bytes) settle(tooBig());
      });
      file.stream.on('error', settle);
      out.on('error', settle);
      out.on('finish', () => settle(null));
      file.stream.pipe(out);
    },
    _removeFile(req, file, cb) {
      fs.rm(file.path, { force: true }).then(() => cb(null), cb);
    },
  };

  /** Parses a multipart upload within a budget of bytes and files (what's left in the project). */
  const handleUpload = (budget) => (req, res, next) => {
    const { bytes, files } = budget(req, res);
    if (files <= 0) return next(tooMany());
    req.uploadBudget = { bytes, used: 0 };
    const upload = multer({
      storage: budgetStorage,
      limits: { files, fileSize: config.maxFileSize, fields: 10, fieldSize: 1024 * 1024 },
    });
    upload.array('files', files)(req, res, (err) => {
      if (!err) return next();
      // Multer already removed what it stored; this is a backstop. Entries without
      // a path are placeholders for files that never reached the disk.
      const cleanup = (req.files || []).filter((f) => f.path).map((f) => fs.rm(f.path, { force: true }));
      Promise.all(cleanup).finally(() => {
        if (err instanceof multer.MulterError) {
          const messages = {
            LIMIT_FILE_SIZE: [413, `Cada archivo puede pesar como máximo ${mb(config.maxFileSize)}.`],
            LIMIT_FILE_COUNT: [413, tooMany().message],
            LIMIT_UNEXPECTED_FILE: [413, tooMany().message],
          };
          const [status, message] = messages[err.code] || [400, 'Solicitud de subida inválida.'];
          return next(new HttpError(status, message));
        }
        next(err);
      });
    });
  };

  const newProjectBudget = () => ({ bytes: config.maxTotalSize, files: config.maxFiles });
  const remainingBudget = (req, res) => {
    const { files } = res.locals.meta;
    const used = files.reduce((sum, f) => sum + f.size, 0);
    return { bytes: Math.max(0, config.maxTotalSize - used), files: config.maxFiles - files.length };
  };

  /**
   * Streams a raw request body (an edited file) to a temp file, keeping at most
   * maxFileSize bytes. Nothing is buffered in memory, so concurrent saves can't
   * exhaust RAM. An oversized body is still read to the end (and discarded) so
   * the client gets the 413 instead of a dropped connection.
   */
  const receiveBody = (req, res, next) => {
    const limit = config.maxFileSize;
    const tooLarge = () => new HttpError(413, `Cada archivo puede pesar como máximo ${mb(limit)}.`);
    if (Number(req.get('content-length')) > limit) return next(tooLarge());

    const tmpPath = path.join(store.tmpDir, crypto.randomUUID());
    let size = 0;
    let over = false;
    const counter = new Transform({
      transform(chunk, encoding, done) {
        size += chunk.length;
        if (size > limit) over = true;
        done(null, over ? undefined : chunk);
      },
    });
    pipeline(req, counter, createWriteStream(tmpPath), (err) => {
      if (err || over) {
        fs.rm(tmpPath, { force: true }).catch(() => {});
        return next(over ? tooLarge() : new HttpError(400, 'La subida se interrumpió.'));
      }
      res.locals.upload = { tmpPath, size };
      next();
    });
  };

  /** Pairs each uploaded temp file with its sanitized relative path. */
  const uploadedEntries = (req) => {
    const files = req.files || [];
    if (!files.length) throw new HttpError(400, 'No se recibió ningún archivo.');

    // Optional JSON array with the relative path of each file, in order.
    // Browsers strip folders from multipart filenames, so the UI sends them here.
    let manifest = [];
    if (req.body?.manifest) {
      try {
        manifest = JSON.parse(req.body.manifest);
      } catch {
        throw new HttpError(400, 'Manifiesto inválido.');
      }
      if (!Array.isArray(manifest)) throw new HttpError(400, 'Manifiesto inválido.');
    }

    const taken = new PathSet();
    return files.map((f, i) => {
      const fallback = sanitizePath(decodeFilename(f.originalname), `archivo-${i + 1}.txt`);
      const p = uniquePath(sanitizePath(manifest[i], fallback), taken);
      taken.add(p);
      return { tmpPath: f.path, path: p, size: f.size };
    });
  };

  const discardUploads = (req) =>
    Promise.all((req.files || []).filter((f) => f.path).map((f) => fs.rm(f.path, { force: true })));

  // ---- Create -------------------------------------------------------------

  const createLimit = rateLimiter({
    perHour: config.uploadsPerHour,
    message: 'Demasiadas subidas. Intenta de nuevo más tarde.',
  });
  const editLimit = rateLimiter({
    perHour: config.editsPerHour,
    message: 'Demasiadas ediciones. Intenta de nuevo más tarde.',
  });

  app.post('/api/projects', createLimit, handleUpload(newProjectBudget), async (req, res, next) => {
    try {
      const entries = uploadedEntries(req);
      const editMode = req.body?.editMode === 'anyone' ? 'anyone' : 'owner';
      const { meta, editToken: token } = await store.create(entries, { editMode });
      const url = `${baseUrl(req)}/${meta.id}`;
      // The key travels in the URL fragment, which browsers never send to the server.
      res.status(201).json({
        ...publicMeta(meta, req, token),
        editToken: token,
        editUrl: `${url}#key=${token}`,
      });
    } catch (err) {
      await discardUploads(req);
      next(err);
    }
  });

  // ---- Read ---------------------------------------------------------------

  const loadProject = async (req, res, next) => {
    try {
      const meta = await store.get(req.params.id);
      if (!meta) throw new HttpError(404, 'Este proyecto no existe o ya expiró.');
      res.locals.meta = meta;
      next();
    } catch (err) {
      next(err);
    }
  };

  const sendFile = async (req, res, next, file) => {
    const { meta } = res.locals;
    // meta was read without the project lock, so the file may have been deleted
    // or replaced since. Open it first and describe what was actually opened.
    let handle;
    try {
      handle = await fs.open(store.filePath(meta.id, file.id), 'r');
    } catch (err) {
      return next(err.code === 'ENOENT' ? new HttpError(404, 'Archivo no encontrado.') : err);
    }
    try {
      const stat = await handle.stat();
      const name = path.posix.basename(file.path);
      const image = IMAGE_TYPES[path.posix.extname(name).toLowerCase()];
      const download = req.query.download !== undefined;
      // Edits replace the file (new inode), so this changes whenever the bytes do.
      const etag = `"${[stat.ino, stat.size, Math.trunc(stat.mtimeMs)].map((n) => n.toString(36)).join('-')}"`;

      let type = 'application/octet-stream';
      if (!file.binary) type = 'text/plain; charset=utf-8';
      else if (image) type = image;

      res.set({
        'Content-Type': type,
        'Content-Disposition': contentDisposition(download ? 'attachment' : 'inline', name),
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        // Files can be edited, so always revalidate.
        'Cache-Control': 'no-cache',
        ETag: etag,
      });
      if (req.get('if-none-match') === etag) {
        await handle.close();
        return res.status(304).end();
      }
      res.set('Content-Length', String(stat.size));
      // pipeline destroys the stream (closing the file) if the client goes away mid-download.
      pipeline(handle.createReadStream(), res, () => {});
    } catch (err) {
      await handle.close().catch(() => {});
      next(err);
    }
  };

  app.get('/api/projects/:id', loadProject, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(publicMeta(res.locals.meta, req));
  });

  app.get('/api/projects/:id/files/:fileId', loadProject, (req, res, next) => {
    const file = res.locals.meta.files.find((f) => f.id === req.params.fileId);
    if (!file) return next(new HttpError(404, 'Archivo no encontrado.'));
    sendFile(req, res, next, file);
  });

  app.get('/api/projects/:id/zip', loadProject, (req, res) => {
    const { meta } = res.locals;
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition('attachment', `${meta.id}.zip`),
    });
    const zip = archiver('zip', { zlib: { level: 6 } });
    const names = zipNames(meta.files.map((f) => f.path));

    // Entries are added one at a time and the open file is tracked: archiver.abort()
    // does not close the file it is reading, so an aborted download would leak it.
    let current = null;
    let added = 0;
    let stopped = false;
    const stop = (err) => {
      if (stopped) return;
      stopped = true;
      zip.abort();
      current?.destroy();
      if (err) {
        if (err.code !== 'ENOENT') console.error('zip failed:', err);
        res.destroy(err);
      }
    };
    const addNext = () => {
      if (stopped) return;
      if (added === meta.files.length) return zip.finalize();
      const i = added++;
      current = createReadStream(store.filePath(meta.id, meta.files[i].id));
      current.on('error', stop);
      zip.append(current, { name: names[i] });
    };
    zip.on('entry', addNext);
    zip.on('error', stop);
    res.on('close', () => {
      if (!res.writableFinished) stop();
    });
    pipeline(zip, res, () => {});
    addNext();
  });

  // ---- Edit ---------------------------------------------------------------

  const requireEdit = (req, res, next) => {
    if (store.canEdit(res.locals.meta, editToken(req))) return next();
    next(new HttpError(403, 'No tienes permiso para editar este proyecto.'));
  };

  const requireOwner = (req, res, next) => {
    if (store.isOwner(res.locals.meta, editToken(req))) return next();
    next(new HttpError(403, 'Solo quien creó el proyecto puede hacer esto.'));
  };

  // Load + authorize before multer touches the disk.
  app.post('/api/projects/:id/files', editLimit, loadProject, requireEdit, handleUpload(remainingBudget), async (req, res, next) => {
    try {
      const { meta, added } = await store.addFiles(req.params.id, uploadedEntries(req), { token: editToken(req) });
      res.status(201).json({ ...publicMeta(meta, req), added: added.map((f) => f.id) });
    } catch (err) {
      await discardUploads(req);
      next(err);
    }
  });

  app.put('/api/projects/:id/files/:fileId', editLimit, loadProject, requireEdit, receiveBody, async (req, res, next) => {
    const { upload } = res.locals;
    try {
      // Version the editor started from; omit it to overwrite unconditionally.
      const base = req.get('x-base-version');
      const baseVersion = base && /^\d+$/.test(base) ? Number(base) : undefined;
      const { meta } = await store.updateFile(req.params.id, req.params.fileId, upload, {
        baseVersion,
        token: editToken(req),
      });
      res.json(publicMeta(meta, req));
    } catch (err) {
      await fs.rm(upload.tmpPath, { force: true });
      next(err);
    }
  });

  app.patch('/api/projects/:id/files/:fileId', editLimit, loadProject, requireEdit, express.json(), async (req, res, next) => {
    try {
      const newPath = sanitizePath(req.body?.path, '');
      if (!newPath) throw new HttpError(400, 'Nombre de archivo inválido.');
      const { meta } = await store.renameFile(req.params.id, req.params.fileId, newPath, { token: editToken(req) });
      res.json(publicMeta(meta, req));
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/projects/:id/files/:fileId', editLimit, loadProject, requireEdit, async (req, res, next) => {
    try {
      const meta = await store.deleteFile(req.params.id, req.params.fileId, { token: editToken(req) });
      res.json(publicMeta(meta, req));
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/projects/:id', editLimit, loadProject, requireOwner, express.json(), async (req, res, next) => {
    try {
      const meta = await store.setEditMode(req.params.id, req.body?.editMode);
      res.json(publicMeta(meta, req));
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/projects/:id', loadProject, requireOwner, async (req, res, next) => {
    try {
      await store.withLock(req.params.id, () => store.remove(req.params.id));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ---- Pages --------------------------------------------------------------

  // Short raw URLs, handy for curl: /<id>/raw/src/index.js
  app.get('/:id/raw/*filepath', (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return next();
    loadProject(req, res, (err) => {
      if (err) return next(err);
      const wanted = req.params.filepath.join('/');
      const file = res.locals.meta.files.find((f) => f.path === wanted);
      if (!file) return next(new HttpError(404, 'Archivo no encontrado.'));
      sendFile(req, res, next, file);
    });
  });

  app.get('/:id', async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return next();
    try {
      const exists = Boolean(await store.get(req.params.id));
      sendPage(res, 'project', exists ? 200 : 404);
    } catch (err) {
      next(err);
    }
  });

  // ---- Errors -------------------------------------------------------------

  app.use((req, res, next) => next(new HttpError(404, 'No encontrado.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      err = new HttpError(413, 'La solicitud es demasiado grande.');
    } else if (err.type === 'entity.parse.failed') {
      err = new HttpError(400, 'Solicitud inválida.');
    }
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Error interno del servidor.' : err.message;
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
    if (status === 404) return sendPage(res, 'project', 404);
    res.status(status).type('text/plain').send(message);
  });

  return app;
}
