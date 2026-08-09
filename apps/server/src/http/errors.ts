import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

/**
 * One error shape for the whole API:
 *
 *     { "error": { "code": "SOME_CODE", "message": "human readable" } }
 *
 * Route handlers throw; this file is the only place that decides a status code
 * or writes an error body. Stack traces never cross the wire.
 *
 * Express 5 forwards rejected promises from handlers to this middleware
 * automatically, so handlers can be plain `async` functions with no try/catch
 * and no express-async-handler wrapper.
 */

export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Prisma's known-request errors carry a `P####` code. Duck-typed so this file
 *  does not depend on Prisma's error classes. */
function prismaErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? code : undefined;
}

export function notFoundHandler(_req: Request, res: Response): void {
  const body: ErrorBody = {
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  };
  res.status(404).json(body);
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request failed validation',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  switch (prismaErrorCode(err)) {
    case 'P2002': // unique constraint violated
      res.status(409).json({
        error: { code: 'CONFLICT', message: 'That already exists' },
      });
      return;
    case 'P2025': // record required but not found
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Not found' },
      });
      return;
    default:
      break;
  }

  // Genuinely unexpected: log it here, tell the client nothing.
  console.error('[server] unhandled error', err);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
  });
}
