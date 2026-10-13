import path from 'node:path';

const MAX_SEGMENT = 128;
const MAX_DEPTH = 16;

/**
 * Turns a user-supplied relative path into a safe, normalized POSIX path.
 * Drops empty, "." and ".." segments and control characters, so the result
 * can never escape the project. Returns `fallback` when nothing is left.
 */
export function sanitizePath(input, fallback) {
  const segments = String(input ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_SEGMENT))
    .filter((s) => s && s !== '.' && s !== '..');
  if (!segments.length) return fallback;
  return segments.slice(-MAX_DEPTH).join('/');
}

/** Appends " (2)", " (3)"… before the extension until the path is unused. */
export function uniquePath(p, taken) {
  if (!taken.has(p)) return p;
  const ext = path.posix.extname(p);
  const base = ext ? p.slice(0, -ext.length) : p;
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Busboy decodes multipart filenames as latin1; recover UTF-8 names when possible. */
export function decodeFilename(name) {
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return utf8.includes('�') ? name : utf8;
}
