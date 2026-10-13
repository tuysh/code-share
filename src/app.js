import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import { ID_RE } from './store.js';
import { HttpError } from './errors.js';
import { sanitizePath, uniquePath, decodeFilename } from './paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = path.join(ROOT, 'views');
const HLJS = path.join(ROOT, 'node_modules', '@highlightjs', 'cdn-assets');

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

function rateLimiter({ perHour, message }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (entry.reset <= now) hits.delete(ip);
  }, 10 * 60 * 1000);
  timer.unref();

  return (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + 60 * 60 * 1000 };
      hits.set(req.ip, entry);
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
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const editToken = (req) => req.get('x-edit-token') || '';

export function createApp(config, store) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

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

  app.use('/assets', express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));
  app.use('/vendor/hljs', express.static(HLJS, { maxAge: '7d' }));
  app.get('/favicon.svg', (req, res) => res.sendFile(path.join(ROOT, 'public', 'favicon.svg')));
  app.get('/', (req, res) => res.sendFile(path.join(VIEWS, 'index.html')));

  app.get('/api/config', (req, res) => {
    res.json({
      ttlMs: config.ttlMs,
      maxFiles: config.maxFiles,
      maxFileSize: config.maxFileSize,
      maxTotalSize: config.maxTotalSize,
    });
  });

  // ---- Upload helpers -----------------------------------------------------

  const upload = multer({
    storage: multer.diskStorage({
      destination: store.tmpDir,
      filename: (req, file, cb) => cb(null, crypto.randomUUID()),
    }),
    limits: {
      files: config.maxFiles,
      fileSize: config.maxFileSize,
      fields: 10,
      fieldSize: 1024 * 1024,
    },
  });

  const handleUpload = (req, res, next) => {
    upload.array('files', config.maxFiles)(req, res, (err) => {
      if (!err) return next();
      const cleanup = (req.files || []).map((f) => fs.rm(f.path, { force: true }));
      Promise.all(cleanup).finally(() => {
        if (err instanceof multer.MulterError) {
          const messages = {
            LIMIT_FILE_SIZE: [413, `Cada archivo puede pesar como máximo ${mb(config.maxFileSize)}.`],
            LIMIT_FILE_COUNT: [413, `Puedes subir como máximo ${config.maxFiles} archivos.`],
            LIMIT_UNEXPECTED_FILE: [413, `Puedes subir como máximo ${config.maxFiles} archivos.`],
          };
          const [status, message] = messages[err.code] || [400, 'Solicitud de subida inválida.'];
          return next(new HttpError(status, message));
        }
        next(err);
      });
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

    const taken = new Set();
    return files.map((f, i) => {
      const fallback = sanitizePath(decodeFilename(f.originalname), `archivo-${i + 1}.txt`);
      const p = uniquePath(sanitizePath(manifest[i], fallback), taken);
      taken.add(p);
      return { tmpPath: f.path, path: p, size: f.size };
    });
  };

  const discardUploads = (req) => Promise.all((req.files || []).map((f) => fs.rm(f.path, { force: true })));

  // ---- Create -------------------------------------------------------------

  const createLimit = rateLimiter({
    perHour: config.uploadsPerHour,
    message: 'Demasiadas subidas. Intenta de nuevo más tarde.',
  });
  const editLimit = rateLimiter({
    perHour: config.editsPerHour,
    message: 'Demasiadas ediciones. Intenta de nuevo más tarde.',
  });

  app.post('/api/projects', createLimit, handleUpload, async (req, res, next) => {
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

  const sendFile = (req, res, file) => {
    const { meta } = res.locals;
    const name = path.posix.basename(file.path);
    const image = IMAGE_TYPES[path.posix.extname(name).toLowerCase()];
    const download = req.query.download !== undefined;
    const etag = `"${file.id}-${file.version}"`;

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
    if (req.get('if-none-match') === etag) return res.status(304).end();
    res.set('Content-Length', String(file.size));
    createReadStream(store.filePath(meta.id, file.id)).pipe(res);
  };

  app.get('/api/projects/:id', loadProject, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(publicMeta(res.locals.meta, req));
  });

  app.get('/api/projects/:id/files/:fileId', loadProject, (req, res, next) => {
    const file = res.locals.meta.files.find((f) => f.id === req.params.fileId);
    if (!file) return next(new HttpError(404, 'Archivo no encontrado.'));
    sendFile(req, res, file);
  });

  app.get('/api/projects/:id/zip', loadProject, (req, res) => {
    const { meta } = res.locals;
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition('attachment', `${meta.id}.zip`),
    });
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', (err) => {
      console.error('zip failed:', err);
      res.destroy(err);
    });
    zip.pipe(res);
    for (const f of meta.files) zip.file(store.filePath(meta.id, f.id), { name: f.path });
    zip.finalize();
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
  app.post('/api/projects/:id/files', editLimit, loadProject, requireEdit, handleUpload, async (req, res, next) => {
    try {
      const { meta, added } = await store.addFiles(req.params.id, uploadedEntries(req));
      res.status(201).json({ ...publicMeta(meta, req), added: added.map((f) => f.id) });
    } catch (err) {
      await discardUploads(req);
      next(err);
    }
  });

  const rawBody = express.raw({ type: () => true, limit: config.maxFileSize });

  app.put('/api/projects/:id/files/:fileId', editLimit, loadProject, requireEdit, rawBody, async (req, res, next) => {
    try {
      const content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      // Version the editor started from; omit it to overwrite unconditionally.
      const base = req.get('x-base-version');
      const baseVersion = base && /^\d+$/.test(base) ? Number(base) : undefined;
      const { meta } = await store.updateFile(req.params.id, req.params.fileId, content, baseVersion);
      res.json(publicMeta(meta, req));
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/projects/:id/files/:fileId', editLimit, loadProject, requireEdit, express.json(), async (req, res, next) => {
    try {
      const newPath = sanitizePath(req.body?.path, '');
      if (!newPath) throw new HttpError(400, 'Nombre de archivo inválido.');
      const { meta } = await store.renameFile(req.params.id, req.params.fileId, newPath);
      res.json(publicMeta(meta, req));
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/projects/:id/files/:fileId', editLimit, loadProject, requireEdit, async (req, res, next) => {
    try {
      const meta = await store.deleteFile(req.params.id, req.params.fileId);
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
      sendFile(req, res, file);
    });
  });

  app.get('/:id', async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return next();
    try {
      const exists = Boolean(await store.get(req.params.id));
      res.status(exists ? 200 : 404).sendFile(path.join(VIEWS, 'project.html'));
    } catch (err) {
      next(err);
    }
  });

  // ---- Errors -------------------------------------------------------------

  app.use((req, res, next) => next(new HttpError(404, 'No encontrado.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      err = new HttpError(413, `Cada archivo puede pesar como máximo ${mb(config.maxFileSize)}.`);
    } else if (err.type === 'entity.parse.failed') {
      err = new HttpError(400, 'Solicitud inválida.');
    }
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Error interno del servidor.' : err.message;
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
    if (status === 404) return res.status(404).sendFile(path.join(VIEWS, 'project.html'));
    res.status(status).type('text/plain').send(message);
  });

  return app;
}
