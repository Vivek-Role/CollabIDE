import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ROLE_RANK,
  assertProjectAccess,
  hasRole,
  requireProjectRole,
} from '../src/modules/auth/authorize.js';
import { currentUser, requireAuth } from '../src/modules/auth/requireAuth.js';
import { errorHandler } from '../src/http/errors.js';
import { createTestApp } from './helpers/app.js';
import { registerUser } from './helpers/auth.js';
import { prisma, resetDb } from './helpers/db.js';
import { addMember, createProject } from './helpers/projects.js';

const authApp = createTestApp();

/** A minimal app that exercises the middleware. The real project routes arrive
 *  in 1.4; this proves the guard itself, in isolation. */
function guardedApp(minRole: 'OWNER' | 'EDITOR' | 'VIEWER') {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.get('/p/:projectId', requireAuth, requireProjectRole(minRole), (req, res) => {
    res.json({ role: req.projectAccess?.role, user: currentUser(req).id });
  });
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('role ranking', () => {
  it('orders VIEWER < EDITOR < OWNER', () => {
    expect(ROLE_RANK.VIEWER).toBeLessThan(ROLE_RANK.EDITOR);
    expect(ROLE_RANK.EDITOR).toBeLessThan(ROLE_RANK.OWNER);
  });

  it('treats a higher role as satisfying a lower requirement', () => {
    expect(hasRole('OWNER', 'VIEWER')).toBe(true);
    expect(hasRole('EDITOR', 'EDITOR')).toBe(true);
    expect(hasRole('VIEWER', 'EDITOR')).toBe(false);
    expect(hasRole('EDITOR', 'OWNER')).toBe(false);
  });
});

describe('assertProjectAccess', () => {
  it('is callable with no Express request object', async () => {
    // This is module 3.4's prerequisite: the WebSocket upgrade has no `req`
    // to pass. If this ever needs mocking, the abstraction has broken.
    const { user } = await registerUser(authApp);
    const projectId = await createProject(user.id);

    const access = await assertProjectAccess(user.id, projectId, 'OWNER');

    expect(access).toEqual({ projectId, userId: user.id, role: 'OWNER' });
  });

  it('lets an OWNER through every requirement', async () => {
    const { user } = await registerUser(authApp);
    const projectId = await createProject(user.id);

    for (const role of ['VIEWER', 'EDITOR', 'OWNER'] as const) {
      await expect(assertProjectAccess(user.id, projectId, role)).resolves.toMatchObject({
        role: 'OWNER',
      });
    }
  });

  it('lets an EDITOR read and edit but not act as owner', async () => {
    const { user: owner } = await registerUser(authApp);
    const { user: editor } = await registerUser(authApp);
    const projectId = await createProject(owner.id);
    await addMember(projectId, editor.id, 'EDITOR');

    await expect(assertProjectAccess(editor.id, projectId, 'VIEWER')).resolves.toBeDefined();
    await expect(assertProjectAccess(editor.id, projectId, 'EDITOR')).resolves.toBeDefined();
    await expect(assertProjectAccess(editor.id, projectId, 'OWNER')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
  });

  it('lets a VIEWER read but not edit', async () => {
    const { user: owner } = await registerUser(authApp);
    const { user: viewer } = await registerUser(authApp);
    const projectId = await createProject(owner.id);
    await addMember(projectId, viewer.id, 'VIEWER');

    await expect(assertProjectAccess(viewer.id, projectId, 'VIEWER')).resolves.toMatchObject({
      role: 'VIEWER',
    });
    await expect(assertProjectAccess(viewer.id, projectId, 'EDITOR')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('returns 404 — not 403 — for a non-member', async () => {
    const { user: owner } = await registerUser(authApp);
    const { user: stranger } = await registerUser(authApp);
    const projectId = await createProject(owner.id);

    await expect(assertProjectAccess(stranger.id, projectId, 'VIEWER')).rejects.toMatchObject({
      status: 404,
      code: 'PROJECT_NOT_FOUND',
    });
  });

  it('gives a non-member and a nonexistent project identical errors', async () => {
    const { user: owner } = await registerUser(authApp);
    const { user: stranger } = await registerUser(authApp);
    const projectId = await createProject(owner.id);

    const forOther = await assertProjectAccess(stranger.id, projectId, 'VIEWER').catch(
      (e: unknown) => e,
    );
    const forMissing = await assertProjectAccess(stranger.id, 'does-not-exist', 'VIEWER').catch(
      (e: unknown) => e,
    );

    // Existence must not be inferable from the response.
    expect(forOther).toMatchObject({ status: 404, code: 'PROJECT_NOT_FOUND' });
    expect(forMissing).toMatchObject({ status: 404, code: 'PROJECT_NOT_FOUND' });
    expect((forOther as Error).message).toBe((forMissing as Error).message);
  });

  it('returns the membership so callers need no second query', async () => {
    const { user: owner } = await registerUser(authApp);
    const { user: editor } = await registerUser(authApp);
    const projectId = await createProject(owner.id);
    await addMember(projectId, editor.id, 'EDITOR');

    const access = await assertProjectAccess(editor.id, projectId, 'VIEWER');

    expect(access.role).toBe('EDITOR');
    expect(access.userId).toBe(editor.id);
  });

  it('stops granting access as soon as membership is removed', async () => {
    const { user: owner } = await registerUser(authApp);
    const { user: editor } = await registerUser(authApp);
    const projectId = await createProject(owner.id);
    await addMember(projectId, editor.id, 'EDITOR');

    await expect(assertProjectAccess(editor.id, projectId, 'EDITOR')).resolves.toBeDefined();

    await prisma.projectMember.delete({
      where: { projectId_userId: { projectId, userId: editor.id } },
    });

    await expect(assertProjectAccess(editor.id, projectId, 'EDITOR')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('requireProjectRole middleware', () => {
  it('allows a member with a sufficient role', async () => {
    const { user: owner } = await registerUser(authApp);
    const { cookie, user: editor } = await registerUser(authApp);
    const projectId = await createProject(owner.id);
    await addMember(projectId, editor.id, 'EDITOR');

    const res = await request(guardedApp('EDITOR')).get(`/p/${projectId}`).set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('EDITOR');
    expect(res.body.user).toBe(editor.id);
  });

  it('is 401 when not signed in at all', async () => {
    const res = await request(guardedApp('VIEWER')).get('/p/anything');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('is 403 for a member whose role is too low', async () => {
    const { user: owner } = await registerUser(authApp);
    const { cookie, user: viewer } = await registerUser(authApp);
    const projectId = await createProject(owner.id);
    await addMember(projectId, viewer.id, 'VIEWER');

    const res = await request(guardedApp('EDITOR')).get(`/p/${projectId}`).set('Cookie', cookie);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('is 404 for a project the user is not in', async () => {
    const { user: owner } = await registerUser(authApp);
    const { cookie } = await registerUser(authApp);
    const projectId = await createProject(owner.id);

    const res = await request(guardedApp('VIEWER')).get(`/p/${projectId}`).set('Cookie', cookie);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROJECT_NOT_FOUND');
  });
});
