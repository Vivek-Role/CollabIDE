import { Redis } from 'ioredis';

import { config } from './config.js';

/**
 * The runner's two Redis connections.
 *
 * Two, and it is a Redis constraint rather than a preference: BullMQ takes
 * ownership of the connection it is given and blocks on it waiting for jobs.
 * A publish sharing that connection would wait behind the blocking pop.
 *
 * (The server's frame subscriber in module 6.6 needs a third of its own, for a
 * different reason: a connection in subscribe mode cannot issue other commands.)
 */

/**
 * For BullMQ. `maxRetriesPerRequest: null` is required, not tuning — a worker
 * blocks for longer than ioredis's default retry budget allows, and bullmq
 * warns and misbehaves without it (verified against bullmq 6.1.1, which still
 * carries the check in redis-connection.js).
 */
export function createQueueConnection(): Redis {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}

/** For publishing run output frames. Ordinary commands, ordinary defaults. */
export function createPublisher(): Redis {
  return new Redis(config.redisUrl);
}
