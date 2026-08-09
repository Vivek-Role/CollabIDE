import { buildApp } from './app.js';
import { config } from './config.js';
import { disconnectDb } from './db.js';

/**
 * Server entrypoint — the only file that opens a socket.
 *
 * Hard rule for every later module: this process never touches the Docker
 * socket. It talks to apps/runner only through the BullMQ queue and Redis
 * channels, with payload types from @collab/shared.
 *
 * The WebSocket server attaches to this same HTTP server in module 3.2.
 */

const app = buildApp();

const server = app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port} (${config.nodeEnv})`);
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[server] ${signal} received — shutting down`);

  // Stop accepting connections, then drain, then release the pg pool. Phase 4
  // adds a persistence flush here so in-flight document updates are not lost.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectDb();

  process.exit(0);
}

process.on('SIGINT', (signal) => void shutdown(signal));
process.on('SIGTERM', (signal) => void shutdown(signal));
