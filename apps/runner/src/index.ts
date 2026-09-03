/**
 * Runner entrypoint.
 *
 * This process is the sole owner of the Docker socket, and it never serves HTTP
 * or WebSocket traffic. User code runs here, inside a container — never in
 * apps/server. The two communicate only through the BullMQ queue and the Redis
 * channels, with payload types from @collab/shared.
 *
 * The sandbox it drives is a reasonable local sandbox, NOT production-grade
 * isolation: the kernel is shared with the host, only Docker's default seccomp
 * profile applies, and there is no user-namespace remapping or gVisor. See
 * docs/notes/sandbox-tests.md.
 */

import { createPublisher, createQueueConnection } from './redis.js';
import { reapStaleContainers } from './sandbox/index.js';
import { startWorker } from './worker.js';

/** How often to sweep for containers a killed runner left behind. */
const REAPER_INTERVAL_MS = 60_000;

const connection = createQueueConnection();
const publisher = createPublisher();
const worker = startWorker(connection, publisher);

// The boot sweep is the one that matters: it cleans up after a runner that was
// SIGKILLed mid-run and could not run its own cleanup. reapStaleContainers
// never throws, so the interval callback needs no guard of its own.
void reapStaleContainers();
const reaperTimer = setInterval(() => void reapStaleContainers(), REAPER_INTERVAL_MS);
// Never hold the process open on the reaper's account.
reaperTimer.unref();

console.log('[runner] started');

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  // Idempotent: a second Ctrl-C while the first close is still awaiting an
  // active job would otherwise quit the connections out from under a run that
  // is mid-publish, losing the terminal frame the client is waiting for.
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[runner] ${signal} received — shutting down`);

  clearInterval(reaperTimer);

  // close() stops taking new jobs and WAITS for the active ones, so a run in
  // progress finishes and publishes its terminal frame. The 10s timeout bounds
  // that wait by construction.
  await worker.close();
  await Promise.all([connection.quit(), publisher.quit()]);

  console.log('[runner] stopped');
  process.exit(0);
}

process.on('SIGINT', (signal) => void shutdown(signal));
process.on('SIGTERM', (signal) => void shutdown(signal));
