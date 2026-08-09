import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';

import { prisma } from './db.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { originCheck } from './http/originCheck.js';
import { authRouter } from './modules/auth/index.js';
import { filesRouter } from './modules/files/index.js';
import { projectsRouter } from './modules/projects/index.js';

/**
 * Builds the Express app **without listening**.
 *
 * This split is the whole point of the module: supertest drives the returned
 * object directly, so tests need no port, race on nothing, and can run in any
 * order. src/index.ts is the only file in the project that calls `listen`.
 *
 * Feature routers mount here from module 1.2 onward — auth first, then
 * projects (1.4) and files (1.5).
 */
export function buildApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(originCheck);

  /**
   * Deliberately queries the database rather than returning a constant: this
   * route is what proves the Prisma 7 driver adapter is wired correctly, which
   * is the risky part of this module.
   */
  app.get('/health', async (_req, res) => {
    await prisma.$queryRaw`select 1`;
    res.json({ ok: true });
  });

  // ── feature routers ──
  app.use('/api/auth', authRouter);
  // Files mount first: the more specific path must win before /:id is tried.
  app.use('/api/projects/:projectId/files', filesRouter);
  app.use('/api/projects', projectsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
