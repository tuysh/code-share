import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import { ID_RE } from './store.js';
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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function rateLimiter({ perHour }) {
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
      return next(new HttpError(429, 'Demasiadas subidas. Intenta de nuevo más tarde.'));
    }
    next();
  };
}

function contentDisposition(type, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function publicMeta(meta, baseUrl) {
  return {
    id: meta.id,
    url: `${baseUrl}/${meta.id}`,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    files: meta.files.map((f, index) => ({ index, ...f })),
  };
}

export function createApp(config, store) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

  const baseUrl = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;

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

  // ---- Upload -------------------------------------------------------------

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

  const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

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

  app.post('/api/projects', rateLimiter({ perHour: config.uploadsPerHour }), handleUpload, async (req, res, next) => {
    const files = req.files || [];
    const discard = () => Promise.all(files.map((f) => fs.rm(f.path, { force: true })));
    try {
      if (!files.length) throw new HttpError(400, 'No se recibió ningún archivo.');

      const total = files.reduce((sum, f) => sum + f.size, 0);
      if (total > config.maxTotalSize) {
        throw new HttpError(413, `El proyecto puede pesar como máximo ${mb(config.maxTotalSize)}.`);
      }

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
      const entries = files.map((f, i) => {
        const fallback = sanitizePath(decodeFilename(f.originalname), `archivo-${i + 1}.txt`);
        const p = uniquePath(sanitizePath(manifest[i], fallback), taken);
        taken.add(p);
        return { tmpPath: f.path, path: p, size: f.size };
      });

      const meta = await store.create(entries);
      res.status(201).json(publicMeta(meta, baseUrl(req)));
    } catch (err) {
      await discard();
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

  const sendFile = (req, res, n) => {
    const { meta } = res.locals;
    const file = meta.files[n];
    const name = path.posix.basename(file.path);
    const image = IMAGE_TYPES[path.posix.extname(name).toLowerCase()];
    const download = req.query.download !== undefined;

    let type = 'application/octet-stream';
    if (!file.binary) type = 'text/plain; charset=utf-8';
    else if (image) type = image;

    res.set({
      'Content-Type': type,
      'Content-Length': String(file.size),
      'Content-Disposition': contentDisposition(download ? 'attachment' : 'inline', name),
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, max-age=300',
    });
    createReadStream(store.filePath(meta.id, n)).pipe(res);
  };

  app.get('/api/projects/:id', loadProject, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(publicMeta(res.locals.meta, baseUrl(req)));
  });

  app.get('/api/projects/:id/files/:n', loadProject, (req, res, next) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || !res.locals.meta.files[n]) {
      return next(new HttpError(404, 'Archivo no encontrado.'));
    }
    sendFile(req, res, n);
  });

  app.get('/api/projects/:id/zip', loadProject, (req, res, next) => {
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
    meta.files.forEach((f, n) => zip.file(store.filePath(meta.id, n), { name: f.path }));
    zip.finalize();
  });

  // Short raw URLs, handy for curl: /<id>/raw/src/index.js
  app.get('/:id/raw/*filepath', (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return next();
    loadProject(req, res, (err) => {
      if (err) return next(err);
      const wanted = req.params.filepath.join('/');
      const n = res.locals.meta.files.findIndex((f) => f.path === wanted);
      if (n === -1) return next(new HttpError(404, 'Archivo no encontrado.'));
      sendFile(req, res, n);
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
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Error interno del servidor.' : err.message;
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
    if (status === 404) return res.status(404).sendFile(path.join(VIEWS, 'project.html'));
    res.status(status).type('text/plain').send(message);
  });

  return app;
}
