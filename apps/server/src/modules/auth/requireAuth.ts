import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../../http/errors.js';
import { authenticateToken, type AuthedUser } from './authenticate.js';
import { SESSION_COOKIE } from './token.js';

/**
 * Authentication only — *who* you are, never *what you may touch*.
 *
 * Project permissions are module 1.3's job (`assertProjectAccess`). Keeping the
 * two apart is what lets the WebSocket layer in 3.4 reuse 1.3 on its own,
 * without dragging an Express request through it.
 *
 * The work of turning a token into a user lives in authenticate.ts, because the
 * WebSocket upgrade in 3.2 needs the same thing without a Request. This file is
 * the Express adapter over it.
 *
 * Every failure is the same 401. Distinguishing "no cookie" from "expired" from
 * "tampered" would tell an attacker which of those they achieved.
 */

export type { AuthedUser };

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

  if (typeof token !== 'string') {
    next(UNAUTHENTICATED());
    return;
  }

  const user = await authenticateToken(token);

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
