import { Router } from 'express';

import { AppError } from '../../http/errors.js';
import { routeParam } from '../../http/params.js';
import { currentUser, requireAuth, requireProjectRole } from '../auth/index.js';
import * as registry from './registry.js';
import { runRequestSchema } from './schemas.js';
import * as service from './service.js';
import { streamRun } from './stream.js';

/**
 * /api/projects/:projectId
 *
 * mergeParams, like the files router: the project id lives in the mount path.
 *
 * EDITOR on both routes, not VIEWER. Running code is not reading it — it
 * consumes host CPU and memory and executes whatever the project contains. A
 * VIEWER gets 403; a non-member gets 404, so project existence stays private.
 */
export const executionRouter: Router = Router({ mergeParams: true });

executionRouter.use(requireAuth);

executionRouter.post('/run', requireProjectRole('EDITOR'), async (req, res) => {
  const { entrypoint } = runRequestSchema.parse(req.body);
  const { id: userId } = currentUser(req);

  const { jobId } = await service.startRun(routeParam(req, 'projectId'), userId, entrypoint);

  // 202: the work was accepted, not completed. The jobId is returned only after
  // the enqueue succeeded.
  res.status(202).json({ jobId });
});

executionRouter.get('/runs/:jobId/stream', requireProjectRole('EDITOR'), (req, res) => {
  const projectId = routeParam(req, 'projectId');
  const jobId = routeParam(req, 'jobId');

  // Authorization has already re-checked who you are and that you are an EDITOR
  // here — membership may have changed since the POST. This is the third leg:
  // the job must belong to THIS project. A mismatch is a 404, the same code as
  // an unknown job, so the URL space leaks nothing.
  const entry = registry.get(jobId);
  if (!entry || entry.projectId !== projectId) {
    throw new AppError(404, 'RUN_NOT_FOUND', 'Run not found');
  }

  streamRun(req, res, jobId);
});
