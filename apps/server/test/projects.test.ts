import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp } from './helpers/app.js';
import { registerUser, uniqueEmail, type SignedInUser } from './helpers/auth.js';
import { prisma, resetDb } from './helpers/db.js';

const app = createTestApp();

async function newProject(owner: SignedInUser, name = 'Demo'): Promise<string> {
  const res = await owner.agent.post('/api/projects').send({ name });
  expect(res.status).toBe(201);
  return res.body.project.id as string;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('create', () => {
  it('creates the project and its OWNER membership together', async () => {
    const owner = await registerUser(app);

    const res = await owner.agent.post('/api/projects').send({ name: 'Demo' });

    expect(res.status).toBe(201);
    expect(res.body.project).toMatchObject({ name: 'Demo', ownerId: owner.user.id, role: 'OWNER' });

    const membership = await prisma.projectMember.findFirst({
      where: { projectId: res.body.project.id, userId: owner.user.id },
    });
    expect(membership?.role).toBe('OWNER');
  });

  it('requires authentication', async () => {
    const anon = await registerUser(app);
    await anon.agent.post('/api/auth/logout').expect(204);

    const res = await anon.agent.post('/api/projects').send({ name: 'Demo' });
    expect(res.status).toBe(401);
  });

  it('rejects an empty name', async () => {
    const owner = await registerUser(app);

    const res = await owner.agent.post('/api/projects').send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('list', () => {
  it('returns only projects you are a member of, with your role', async () => {
    const owner = await registerUser(app);
    const other = await registerUser(app);
    const mine = await newProject(owner, 'Mine');
    await newProject(other, 'Theirs');

    const res = await owner.agent.get('/api/projects');

    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0]).toMatchObject({ id: mine, name: 'Mine', role: 'OWNER' });
  });

  it('includes a project you were invited to, with the invited role', async () => {
    const owner = await registerUser(app);
    const editor = await registerUser(app);
    const projectId = await newProject(owner);

    await owner.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: editor.user.email, role: 'EDITOR' })
      .expect(201);

    const res = await editor.agent.get('/api/projects');

    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0]).toMatchObject({ id: projectId, role: 'EDITOR' });
  });
});

describe('read', () => {
  it('returns the project with its member list', async () => {
    const owner = await registerUser(app);
    const projectId = await newProject(owner);

    const res = await owner.agent.get(`/api/projects/${projectId}`);

    expect(res.status).toBe(200);
    expect(res.body.project.id).toBe(projectId);
    expect(res.body.members).toEqual([
      expect.objectContaining({ userId: owner.user.id, email: owner.user.email, role: 'OWNER' }),
    ]);
  });

  it('is 404 for a non-member', async () => {
    const owner = await registerUser(app);
    const stranger = await registerUser(app);
    const projectId = await newProject(owner);

    const res = await stranger.agent.get(`/api/projects/${projectId}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('gives a non-member the same answer as a project that does not exist', async () => {
    const owner = await registerUser(app);
    const stranger = await registerUser(app);
    const projectId = await newProject(owner);

    const hidden = await stranger.agent.get(`/api/projects/${projectId}`);
    const missing = await stranger.agent.get('/api/projects/nope');

    expect(hidden.body).toEqual(missing.body);
  });
});

describe('rename and delete', () => {
  it('lets an OWNER rename', async () => {
    const owner = await registerUser(app);
    const projectId = await newProject(owner);

    const res = await owner.agent.patch(`/api/projects/${projectId}`).send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe('Renamed');
  });

  it('refuses a rename by an EDITOR with 403', async () => {
    const owner = await registerUser(app);
    const editor = await registerUser(app);
    const projectId = await newProject(owner);
    await owner.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: editor.user.email, role: 'EDITOR' })
      .expect(201);

    const res = await editor.agent.patch(`/api/projects/${projectId}`).send({ name: 'Nope' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('cascades members and files on delete', async () => {
    const owner = await registerUser(app);
    const editor = await registerUser(app);
    const projectId = await newProject(owner);
    await owner.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: editor.user.email, role: 'EDITOR' })
      .expect(201);
    await prisma.file.create({ data: { projectId, path: 'main.py', content: 'print(1)' } });

    await owner.agent.delete(`/api/projects/${projectId}`).expect(204);

    expect(await prisma.project.count({ where: { id: projectId } })).toBe(0);
    expect(await prisma.projectMember.count({ where: { projectId } })).toBe(0);
    expect(await prisma.file.count({ where: { projectId } })).toBe(0);
    // The users themselves survive.
    expect(await prisma.user.count()).toBe(2);
  });

  it('refuses a delete by an EDITOR', async () => {
    const owner = await registerUser(app);
    const editor = await registerUser(app);
    const projectId = await newProject(owner);
    await owner.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: editor.user.email, role: 'EDITOR' })
      .expect(201);

    await editor.agent.delete(`/api/projects/${projectId}`).expect(403);
    expect(await prisma.project.count({ where: { id: projectId } })).toBe(1);
  });
});

describe('members', () => {
  it('invites by email', async () => {
    const owner = await registerUser(app);
    const invitee = await registerUser(app);
    const projectId = await newProject(owner);

    const res = await owner.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: invitee.user.email, role: 'VIEWER' });

    expect(res.status).toBe(201);
    expect(res.body.member).toMatchObject({ userId: invitee.user.id, role: 'VIEWER' });
  });

  it('matches the invite email case-insensitively', async () => {
    const owner = await registerUser(app);
    const invitee = await registerUser(app);
    const projectId = await newProject(owner);

    await owner.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: invitee.user.email.toUpperCase(), role: 'EDITOR' })
      .expect(201);
  });

  it('is 404 for an email with no account', async () => {
    const owner = await registerUser(app);
    const projectId = await newProject(owner);

    const res = await owner.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: uniqueEmail('ghost'), role: 'EDITOR' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('is 409 when the user is already a member', async () => {
    const owner = await registerUser(app);
    const invitee = await registerUser(app);
    const projectId = await newProject(owner);
    const body = { email: invitee.user.email, role: 'EDITOR' };

    await owner.agent.post(`/api/projects/${projectId}/members`).send(body).expect(201);
    const res = await owner.agent.post(`/api/projects/${projectId}/members`).send(body);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_MEMBER');
  });

  it('refuses an invite from an EDITOR', async () => {
    const owner = await registerUser(app);
    const editor = await registerUser(app);
    const outsider = await registerUser(app);
    const projectId = await newProject(owner);
    await owner.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: editor.user.email, role: 'EDITOR' })
      .expect(201);

    const res = await editor.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: outsider.user.email, role: 'EDITOR' });

    expect(res.status).toBe(403);
  });

  it('changes a role', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const projectId = await newProject(owner);
    await owner.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: member.user.email, role: 'VIEWER' })
      .expect(201);

    const res = await owner.agent
      .patch(`/api/projects/${projectId}/members/${member.user.id}`)
      .send({ role: 'EDITOR' });

    expect(res.status).toBe(200);
    expect(res.body.member.role).toBe('EDITOR');

    // ...and it takes effect: the member can now do EDITOR-only things.
    const listed = await member.agent.get('/api/projects');
    expect(listed.body.projects[0].role).toBe('EDITOR');
  });

  it('removes a member', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const projectId = await newProject(owner);
    await owner.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: member.user.email, role: 'EDITOR' })
      .expect(201);

    await owner.agent
      .delete(`/api/projects/${projectId}/members/${member.user.id}`)
      .expect(204);

    // Access is gone immediately.
    await member.agent.get(`/api/projects/${projectId}`).expect(404);
  });

  it('is 404 when the target is not a member', async () => {
    const owner = await registerUser(app);
    const stranger = await registerUser(app);
    const projectId = await newProject(owner);

    const res = await owner.agent.delete(
      `/api/projects/${projectId}/members/${stranger.user.id}`,
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MEMBER_NOT_FOUND');
  });
});

describe('the last owner', () => {
  it('cannot be demoted', async () => {
    const owner = await registerUser(app);
    const projectId = await newProject(owner);

    const res = await owner.agent
      .patch(`/api/projects/${projectId}/members/${owner.user.id}`)
      .send({ role: 'EDITOR' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_OWNER');
  });

  it('can be demoted once a second owner exists', async () => {
    const owner = await registerUser(app);
    const coOwner = await registerUser(app);
    const projectId = await newProject(owner);
    await owner.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: coOwner.user.email, role: 'OWNER' })
      .expect(201);

    await coOwner.agent
      .patch(`/api/projects/${projectId}/members/${owner.user.id}`)
      .send({ role: 'EDITOR' })
      .expect(200);
  });

  it('cannot be removed', async () => {
    const owner = await registerUser(app);
    const coOwner = await registerUser(app);
    const projectId = await newProject(owner);
    await owner.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: coOwner.user.email, role: 'EDITOR' })
      .expect(201);

    // coOwner is only an EDITOR, so owner is still the sole OWNER.
    const res = await owner.agent.delete(
      `/api/projects/${projectId}/members/${owner.user.id}`,
    );

    // Self-removal is refused before the owner count is even consulted.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_REMOVE_SELF');
  });

  it('refuses removal of the sole owner by another owner', async () => {
    const owner = await registerUser(app);
    const coOwner = await registerUser(app);
    const projectId = await newProject(owner);
    await owner.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: coOwner.user.email, role: 'OWNER' })
      .expect(201);

    // Two owners: removing one is fine.
    await coOwner.agent
      .delete(`/api/projects/${projectId}/members/${owner.user.id}`)
      .expect(204);

    // Now coOwner is the last one, and cannot be demoted.
    const res = await coOwner.agent
      .patch(`/api/projects/${projectId}/members/${coOwner.user.id}`)
      .send({ role: 'VIEWER' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_OWNER');
  });
});
