import { RUN_QUEUE_NAME } from '@collab/shared';
import type { RunJob } from '@collab/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { config } from '../../config.js';

/**
 * The producer side of the execution queue.
 *
 * apps/server adds jobs; apps/runner consumes them. There is deliberately no
 * BullMQ Worker here — instantiating one would put user code a single import
 * away from the API process, which is exactly what ADR-004 exists to prevent.
 * The runner remains the sole owner of the Docker socket.
 *
 * LAZY ON PURPOSE. test/helpers/app.ts calls buildApp() directly, so everything
 * app.ts transitively imports runs inside all 211 existing tests. A `new Queue`
 * at module scope would open an ioredis connection in test files that have
 * nothing to do with execution — giving the suite a hard Redis dependency it has
 * never had, and leaving handles open that can stop Vitest exiting.
 *
 * So: importing this module connects to nothing. Only a real POST /run does.
 */

let queue: Queue<RunJob> | null = null;
let connection: Redis | null = null;

export function getQueue(): Queue<RunJob> {
  if (!queue) {
    // maxRetriesPerRequest: null is BullMQ's requirement, not tuning.
    connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue<RunJob>(RUN_QUEUE_NAME, { connection });
  }
  return queue;
}

/** Called from src/index.ts on shutdown, beside disconnectDb(). */
export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
