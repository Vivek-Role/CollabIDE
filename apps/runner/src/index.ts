/**
 * Runner entrypoint — stub.
 *
 * Hard rule for every later module: this process is the sole owner of the
 * Docker socket, and it never serves HTTP or WebSocket traffic. User code
 * runs here, inside a container — never in apps/server.
 *
 * BullMQ worker arrives in module 6.5, the Docker driver in 6.3.
 */

export const RUNNER_NAME = '@collab/runner';
