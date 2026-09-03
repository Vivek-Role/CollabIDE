import { prisma } from '../../db.js';
import { verifyToken } from './token.js';

/**
 * Turn a session token into a user, or into nothing.
 *
 * This is the whole of "who are you", with no HTTP anywhere near it — which is
 * why it is its own file: `requireAuth` adapts it for Express, and module 3.2's
 * WebSocket upgrade calls it directly, where there is no `req` to hand around.
 *
 * Returns null for every failure — no cookie value, malformed token, expired
 * token, wrong signature, deleted user. Distinguishing them would tell an
 * attacker which of those they achieved.
 */

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
}

export async function authenticateToken(token: string): Promise<AuthedUser | null> {
  if (token.length === 0) return null;

  let userId: string;
  try {
    ({ userId } = await verifyToken(token));
  } catch {
    return null;
  }

  // The token is only a claim. The user may have been deleted since it was
  // issued, so the row is the authority.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true },
  });

  return user;
}
