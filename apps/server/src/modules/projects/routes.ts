import { Router } from 'express';

import { routeParam } from '../../http/params.js';
import { currentUser, requireAuth, requireProjectRole } from '../auth/index.js';
import { addMemberSchema, changeRoleSchema, createProjectSchema, renameProjectSchema } from './schemas.js';
import * as service from './service.js';

/**
 * /api/projects
 *
 * Every route is authenticated. Every route that names a project is guarded by
 * `requireProjectRole` (module 1.3) — the project id comes from `:id`, and a
 * non-member gets a 404 so project existence stays private.
 *
 * Handlers stay thin on purpose: parse -> (guard already ran) -> call the
 * service -> shape the response.
 */
export const projectsRouter: Router = Router();

projectsRouter.use(requireAuth);

projectsRouter.post('/', async (req, res) => {
  const { name } = createProjectSchema.parse(req.body);
  const project = await service.createProject(currentUser(req).id, name);

  res.status(201).json({ project: { ...project, role: 'OWNER' } });
});

projectsRouter.get('/', async (req, res) => {
  const projects = await service.listProjects(currentUser(req).id);
  res.json({ projects });
});

projectsRouter.get('/:id', requireProjectRole('VIEWER', 'id'), async (req, res) => {
  const { project, members } = await service.getProject(routeParam(req, 'id'));
  res.json({ project, members, role: req.projectAccess?.role });
});

projectsRouter.patch('/:id', requireProjectRole('OWNER', 'id'), async (req, res) => {
  const { name } = renameProjectSchema.parse(req.body);
  const project = await service.renameProject(routeParam(req, 'id'), name);

  res.json({ project });
});

projectsRouter.delete('/:id', requireProjectRole('OWNER', 'id'), async (req, res) => {
  await service.deleteProject(routeParam(req, 'id'));
  res.status(204).end();
});

// ── Members ─────────────────────────────────────────────────────────────────

projectsRouter.post('/:id/members', requireProjectRole('OWNER', 'id'), async (req, res) => {
  const { email, role } = addMemberSchema.parse(req.body);
  const member = await service.addMember(routeParam(req, 'id'), email, role);

  res.status(201).json({ member });
});

projectsRouter.patch(
  '/:id/members/:userId',
  requireProjectRole('OWNER', 'id'),
  async (req, res) => {
    const { role } = changeRoleSchema.parse(req.body);
    const member = await service.changeMemberRole(routeParam(req, 'id'), routeParam(req, 'userId'), role);

    res.json({ member });
  },
);

projectsRouter.delete(
  '/:id/members/:userId',
  requireProjectRole('OWNER', 'id'),
  async (req, res) => {
    await service.removeMember(routeParam(req, 'id'), routeParam(req, 'userId'), currentUser(req).id);
    res.status(204).end();
  },
);
