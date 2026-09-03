import { Router } from 'express';

import { routeParam } from '../../http/params.js';
import { requireAuth, requireProjectRole } from '../auth/index.js';
import { createFileSchema, moveFileSchema } from './schemas.js';
import * as service from './service.js';

/**
 * /api/projects/:projectId/files
 *
 * `mergeParams` is required: the project id lives in the mount path, not in
 * these routes, and without it `:projectId` would be invisible here — and the
 * authorization guard would have nothing to check.
 *
 * Reads need VIEWER, writes need EDITOR. That split is the reason the VIEWER
 * role exists, and module 3.4 enforces the same one over the WebSocket.
 */
export const filesRouter: Router = Router({ mergeParams: true });

filesRouter.use(requireAuth);

filesRouter.get('/', requireProjectRole('VIEWER'), async (req, res) => {
  const tree = await service.listTree(routeParam(req, 'projectId'));
  res.json({ tree });
});

filesRouter.get('/:fileId', requireProjectRole('VIEWER'), async (req, res) => {
  const file = await service.readFile(routeParam(req, 'projectId'), routeParam(req, 'fileId'));
  res.json({ file });
});

filesRouter.post('/', requireProjectRole('EDITOR'), async (req, res) => {
  const { path, isDir } = createFileSchema.parse(req.body);
  const file = await service.createFile(routeParam(req, 'projectId'), path, isDir);

  res.status(201).json({ file });
});

// There is no PUT: file content is written through the collaboration socket and
// materialized by modules/persistence (4.4). A REST write would be silently
// overwritten by the next flush.

filesRouter.patch('/:fileId', requireProjectRole('EDITOR'), async (req, res) => {
  const { path } = moveFileSchema.parse(req.body);
  const file = await service.moveFile(
    routeParam(req, 'projectId'),
    routeParam(req, 'fileId'),
    path,
  );

  res.json({ file });
});

filesRouter.delete('/:fileId', requireProjectRole('EDITOR'), async (req, res) => {
  const deleted = await service.deleteFile(
    routeParam(req, 'projectId'),
    routeParam(req, 'fileId'),
  );

  res.json({ deleted });
});
