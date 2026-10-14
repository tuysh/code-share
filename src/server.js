import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createApp } from './app.js';

const config = loadConfig();
const store = new Store(config);
await store.init();
store.startSweeper(config.sweepIntervalMs);

const app = createApp(config, store);
const server = app.listen(config.port, config.host, () => {
  console.log(`code-share escuchando en http://${config.host}:${config.port}`);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) {
    // A second Ctrl+C: stop waiting.
    process.exit(1);
  }
  shuttingDown = true;
  store.stop();
  server.close(() => process.exit(0));
  // Keep-alive sockets would hold close() open for seconds after their last
  // request; drop each one as soon as it goes idle so the drain ends promptly.
  setInterval(() => server.closeIdleConnections(), 250).unref();
  // Docker sends SIGKILL after 10 s; give up just before that, visibly.
  setTimeout(() => {
    console.error('Apagado forzado: había solicitudes en curso.');
    server.closeAllConnections();
    process.exit(1);
  }, 8000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
