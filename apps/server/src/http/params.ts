import type { Request } from 'express';

import { AppError } from './errors.js';

/**
 * Express 5 types `req.params[name]` as `string | string[] | undefined`, because
 * a wildcard or repeated parameter can produce an array. For our routes it is
 * always a single string — but the type is honest and the cast to prove it
 * belongs in one place rather than at every call site.
 */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];

  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(400, 'INVALID_PARAM', `Missing or malformed route parameter: ${name}`);
  }
  return value;
}
