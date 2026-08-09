import type { NextFunction, Request, Response } from 'express';

import { config } from '../config.js';
import { AppError } from './errors.js';

/**
 * A second line of defense behind the session cookie's SameSite=Strict.
 *
 * SameSite already stops a cross-site form or fetch from carrying the cookie,
 * so this is not load-bearing — but it is four lines, and it turns a future
 * cookie-flag mistake into a 403 instead of a real CSRF.
 *
 * Only mutating methods are checked: a GET with a foreign Origin is a normal
 * cross-origin read and is not the browser doing something on the user's behalf.
 * A missing Origin header is allowed through — curl, server-to-server calls and
 * older clients simply do not send one.
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function originCheck(req: Request, _res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.get('origin');
  if (origin !== undefined && origin !== config.webOrigin) {
    throw new AppError(403, 'BAD_ORIGIN', 'Request origin is not allowed');
  }

  next();
}
