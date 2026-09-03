/**
 * The two decisions a reconnect has to make, kept pure so they can be read on
 * their own: how long to wait, and whether to bother at all.
 *
 * No imports, no state, no socket — the lifecycle they serve lives in
 * CollabProvider, and splitting that across two files would be worse than the
 * length it saves. Internal to this feature; not exported through the barrel.
 */

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

/**
 * Application close codes that mean "do not try again".
 *
 * Authorization runs once, at join (module 3.4b): a role change, a removal, a
 * deleted project and a deleted file all close the socket with 4409. Retrying
 * any of these is a client hammering a room it can never re-enter, with the same
 * credential that was just refused.
 *
 * 4403 is in the set even though nothing sends it yet: joining needs only VIEWER
 * and a VIEWER is admitted read-only, so syncHandler's Forbidden branch is
 * currently unreachable. It is a real call site all the same, and "reserved"
 * means nobody sends it — not that the client may retry it forever.
 *
 * Everything else is retryable — 1006 (server down, network gone), 1001 (server
 * going away), 1011, and a connection that never opens. 1000 is retryable too:
 * our own destroy() removes the listeners before closing, so a normal closure
 * that reaches the handler came from the server.
 */
const TERMINAL = new Set([
  4400, // malformed doc parameter — it will be malformed next time too
  4401, // unauthenticated — the cookie is missing or expired
  4403, // a member, but not senior enough — the same cookie will be refused again
  4404, // non-member, or no such file
  4409, // access changed, or the file was deleted, mid-session
]);

export function isTerminalClose(code: number): boolean {
  return TERMINAL.has(code);
}

/**
 * Full jitter: a uniform sample below an exponentially growing ceiling of
 * 500ms, 1s, 2s, 4s, 8s, 15s, 15s...
 *
 * The failure this guards against is a server restart dropping every client at
 * the same instant. A fixed delay reconnects them all in the same millisecond,
 * repeatedly; sampling the whole window is the simplest thing that spreads them.
 */
export function backoffDelay(attempt: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.random() * ceiling;
}
