import path from 'node:path';

// Common filesystems allow 255 bytes per name; stay well below to leave room for " (n)".
const MAX_SEGMENT_BYTES = 200;
const MAX_DEPTH = 16;

/** Cuts `s` to at most `maxBytes` of UTF-8 without splitting a character. */
function clipBytes(s, maxBytes) {
  let bytes = 0;
  let out = '';
  for (const ch of s) {
    bytes += Buffer.byteLength(ch);
    if (bytes > maxBytes) break;
    out += ch;
  }
  return out;
}

/**
 * Turns a user-supplied relative path into a safe, normalized POSIX path.
 * Drops empty, "." and ".." segments and control characters, so the result
 * can never escape the project. Returns `fallback` when nothing is left.
 */
export function sanitizePath(input, fallback) {
  const segments = String(input ?? '')
    // Lone surrogates can't be encoded (encodeURIComponent throws on them).
    .toWellFormed()
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => clipBytes(s.replace(/[\x00-\x1f\x7f]/g, '').trim(), MAX_SEGMENT_BYTES).trim())
    .filter((s) => s && s !== '.' && s !== '..');
  if (!segments.length) return fallback;
  return segments.slice(-MAX_DEPTH).join('/');
}

const parentDirs = (p) => {
  const parts = p.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
};

/**
 * The files of a project plus the folders they imply. A path is free only if it
 * is neither a file nor a folder yet and none of its folders is a file: "src"
 * and "src/index.js" can't coexist, or the project couldn't be extracted.
 */
export class PathSet {
  constructor(paths = [], key = (p) => p) {
    this.key = key;
    this.files = new Set();
    this.dirs = new Set();
    for (const p of paths) this.add(p);
  }

  add(p) {
    this.files.add(this.key(p));
    for (const dir of parentDirs(p)) this.dirs.add(this.key(dir));
  }

  isFile(p) {
    return this.files.has(this.key(p));
  }

  free(p) {
    const k = this.key(p);
    return !this.files.has(k) && !this.dirs.has(k) && !parentDirs(p).some((d) => this.isFile(d));
  }
}

const withSuffix = (name, n, keepExt) => {
  const ext = keepExt ? path.posix.extname(name) : '';
  const base = ext ? name.slice(0, -ext.length) : name;
  return `${base} (${n})${ext}`;
};

/**
 * Returns `p`, or a variant with " (2)", " (3)"… that doesn't collide with `taken`.
 * A folder that is already a file gets the suffix: "lib/x.js" next to a file "lib"
 * becomes "lib (2)/x.js".
 */
export function uniquePath(p, taken) {
  const parts = p.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const join = () => parts.slice(0, i + 1).join('/');
    const name = parts[i];
    for (let n = 2; taken.isFile(join()); n++) parts[i] = withSuffix(name, n, false);
  }
  const leaf = parts.at(-1);
  for (let n = 2; !taken.free(parts.join('/')); n++) parts[parts.length - 1] = withSuffix(leaf, n, true);
  return parts.join('/');
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** A path segment that Windows can create: no <>:"|?*, no trailing dot or space, no reserved name. */
function portableSegment(s) {
  const out = s.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
  return WINDOWS_RESERVED.test(out) ? `_${out}` : out;
}

/**
 * Entry names for the project zip. They must extract everywhere, so they are
 * made Windows-safe and deduplicated ignoring case (Windows and macOS would
 * otherwise overwrite README.md with readme.md).
 */
export function zipNames(paths) {
  const taken = new PathSet([], (p) => p.toLowerCase());
  return paths.map((p) => {
    const name = uniquePath(p.split('/').map(portableSegment).join('/'), taken);
    taken.add(name);
    return name;
  });
}

/** Busboy decodes multipart filenames as latin1; recover UTF-8 names when possible. */
export function decodeFilename(name) {
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return utf8.includes('�') ? name : utf8;
}
