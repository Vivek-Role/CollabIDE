/**
 * The execution module's public surface.
 *
 * apps/server enqueues runs and streams their output. It never imports Docker
 * and nothing from apps/runner: the two communicate only through the BullMQ
 * queue and the Redis channels, with payload types from @collab/shared.
 */

export { closeQueue } from './queue.js';
export { closeAll as closeAllRuns } from './registry.js';
export { executionRouter } from './routes.js';
