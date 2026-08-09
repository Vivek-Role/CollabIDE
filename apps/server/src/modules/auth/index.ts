/**
 * The auth module's public surface. Cross-module imports go through this
 * barrel only — nothing outside this folder reaches into its files directly.
 *
 * Authorization lives alongside authentication but in its own file, so the
 * WebSocket layer in 3.4 can use `assertProjectAccess` without touching Express.
 */

export {
  ROLE_RANK,
  assertProjectAccess,
  hasRole,
  requireProjectRole,
  type ProjectAccess,
} from './authorize.js';
export { hashPassword, verifyPassword } from './password.js';
export { currentUser, requireAuth, type AuthedUser } from './requireAuth.js';
export { authRouter } from './routes.js';
export {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  sessionCookieOptions,
  signToken,
  verifyToken,
  type SessionClaims,
} from './token.js';
