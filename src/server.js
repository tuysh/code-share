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

const shutdown = () => {
  store.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
