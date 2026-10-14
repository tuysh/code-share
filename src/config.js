import path from 'node:path';

/** Integer from the environment, clamped to [min, max] so a typo can't break the server. */
const int = (value, fallback, min, max) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

/**
 * Express "trust proxy" from TRUST_PROXY: a number of proxy hops, or addresses /
 * subnets ("loopback, 172.16.0.0/12"). "true" means one hop: trusting every hop
 * would take the client-controlled left end of X-Forwarded-For as the client IP.
 */
export function parseTrustProxy(value = '') {
  const v = value.trim();
  if (!v || /^(false|0)$/i.test(v)) return false;
  if (/^true$/i.test(v)) return 1;
  if (/^\d+$/.test(v)) return Math.min(Number(v), 10);
  return v;
}

const MB = 1024 * 1024;

export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 3000, 0, 65535),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    ttlMs: int(env.TTL_HOURS, 24, 1, 24 * 365) * 60 * 60 * 1000,
    // Must stay within the 4–32 characters project links accept (ID_RE in store.js).
    idLength: int(env.ID_LENGTH, 6, 4, 32),
    maxFiles: int(env.MAX_FILES, 100, 1, 10_000),
    maxFileSize: int(env.MAX_FILE_SIZE_MB, 10, 1, 1024) * MB,
    maxTotalSize: int(env.MAX_TOTAL_SIZE_MB, 50, 1, 10_240) * MB,
    uploadsPerHour: int(env.UPLOADS_PER_HOUR, 30, 1, 1_000_000),
    editsPerHour: int(env.EDITS_PER_HOUR, 600, 1, 1_000_000),
    // Timers overflow above ~24.8 days (and then fire every millisecond).
    sweepIntervalMs: int(env.SWEEP_INTERVAL_SECONDS, 60, 1, 86_400) * 1000,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    production: env.NODE_ENV === 'production',
  };
}
