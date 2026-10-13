import path from 'node:path';

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const MB = 1024 * 1024;

export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    ttlMs: int(env.TTL_HOURS, 24) * 60 * 60 * 1000,
    idLength: int(env.ID_LENGTH, 6),
    maxFiles: int(env.MAX_FILES, 100),
    maxFileSize: int(env.MAX_FILE_SIZE_MB, 10) * MB,
    maxTotalSize: int(env.MAX_TOTAL_SIZE_MB, 50) * MB,
    uploadsPerHour: int(env.UPLOADS_PER_HOUR, 30),
    editsPerHour: int(env.EDITS_PER_HOUR, 600),
    sweepIntervalMs: int(env.SWEEP_INTERVAL_SECONDS, 60) * 1000,
    trustProxy: env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1',
  };
}
