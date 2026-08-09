import type { NextFunction, Request, Response } from 'express';

import { prisma } from '../../db.js';
import { AppError } from '../../http/errors.js';
import { SESSION_COOKIE, verifyToken } from './token.js';

/**
 * Authentication only — *who* you are, never *what you may touch*.
 *
 * Project permissions are module 1.3's job (`assertProjectAccess`). Keeping the
 * two apart is what lets the WebSocket layer in 3.4 reuse 1.3 on its own,
 * without dragging an Express request through it.
 *
 * Every failure is the same 401. Distinguishing "no cookie" from "expired" from
 * "tampered" would tell an attacker which of those they achieved.
 */

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

const UNAUTHENTICATED = () =>
  new AppError(401, 'UNAUTHENTICATED', 'Authentication required');

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token: unknown = req.cookies?.[SESSION_COOKIE];

  if (typeof token !== 'string' || token.length === 0) {
    next(UNAUTHENTICATED());
    return;
  }

  let userId: string;
  try {
    ({ userId } = await verifyToken(token));
  } catch {
    next(UNAUTHENTICATED());
    return;
  }

  // The token is only a claim. The user may have been deleted since it was
  // issued, so the row is the authority.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true },
  });

  if (!user) {
    next(UNAUTHENTICATED());
    return;
  }

  req.user = user;
  next();
}

/** Narrowing helper: inside a requireAuth-protected handler the user is always
 *  present, but the type is optional because unprotected routes share Request. */
export function currentUser(req: Request): AuthedUser {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return req.user;
}
