import { buildApp } from './app.js';
import { config } from './config.js';
import { disconnectDb } from './db.js';
import { attachWsServer, flushAllRooms } from './modules/collab/index.js';
import { closeAllRuns, closeQueue } from './modules/execution/index.js';
import { closeDocBus } from './modules/redis/index.js';

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

const closeWsServer = attachWsServer(server);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[server] ${signal} received — shutting down`);

  // Close the WebSocket endpoint first: server.close() waits for connections to
  // end, and an open socket never ends on its own. Then write open documents
  // back to their files while the database is still connected — module 4.3
  // replaces that with the real persistence flush.
  closeWsServer();
  await flushAllRooms();
  // Run subscriptions and the execution queue (6.6). Both are no-ops if no run
  // ever happened — the queue is created lazily.
  await closeAllRuns();
  await closeQueue();
  // The doc bus (7.1), after the flush above: closing it earlier would drop
  // frames peers on another instance could still have used. A no-op if nothing
  // ever subscribed or published.
  await closeDocBus();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectDb();

  process.exit(0);
}

process.on('SIGINT', (signal) => void shutdown(signal));
process.on('SIGTERM', (signal) => void shutdown(signal));
