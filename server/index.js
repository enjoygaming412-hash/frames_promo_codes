import path from 'node:path';

import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const dbPath = process.env.DB_PATH || path.join(dataDir, 'rewards.db');

const app = createApp({ dbPath });

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`FRAMES BASEMENT REWARDS running on http://0.0.0.0:${port}`);
  console.log(`Database: ${dbPath}`);
  console.log(`Admin panel: http://0.0.0.0:${port}/admin`);
});

function shutdown(signal) {
  console.log(`${signal} received, closing server.`);
  server.close(() => {
    try {
      app.locals.store.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
