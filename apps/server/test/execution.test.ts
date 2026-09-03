import { MAX_RUN_FILES } from '@collab/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp } from './helpers/app.js';
import { registerUser, type SignedInUser } from './helpers/auth.js';
import { prisma, resetDb } from './helpers/db.js';
import { addMember } from './helpers/projects.js';

/**
 * Module 6.6 — the parts that need no Redis.
 *
 * Everything here runs before a job is ever enqueued: authorization, entrypoint
 * validation and the input caps all reject first. That is deliberate — it is
 * also what proves the queue is lazy, since these tests never start Redis and
 * the suite still passes.
 *
 * The streaming half (SSE, frames, cleanup) is verified against a live server
 * and runner with curl, because supertest buffers a response until it ends and
 * an SSE stream deliberately does not end until the run does.
 */

const app = createTestApp();

interface Fixture {
  owner: SignedInUser;
  projectId: string;
  runUrl: string;
}

async function setup(): Promise<Fixture> {
  const owner = await registerUser(app);
  const created = await owner.agent.post('/api/projects').send({ name: 'Runnable' });
  const projectId = created.body.project.id as string;

  return { owner, projectId, runUrl: `/api/projects/${projectId}/run` };
}

/** Writes File.content directly: only modules/persistence writes it in prod. */
async function addFile(projectId: string, path: string, content = 'print("hi")\n'): Promise<void> {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    await prisma.file.upsert({
      where: { projectId_path: { projectId, path: dir } },
      update: {},
      create: { projectId, path: dir, isDir: true, content: '' },
    });
  }
  await prisma.file.create({ data: { projectId, path, isDir: false, content } });
}

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/projects/:projectId/run — authorization', () => {
  it('rejects an unauthenticated caller', async () => {
    const f = await setup();
    await addFile(f.projectId, 'main.py');

    // A bare request, not the signed-in agent: `.set('Cookie', '')` does not
    // clear an agent's cookie jar, so it would still be authenticated.
    const res = await request(app).post(f.runUrl).send({ entrypoint: 'main.py' });

    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-member, so project existence stays private', async () => {
    const f = await setup();
    await addFile(f.projectId, 'main.py');
    const stranger = await registerUser(app);

    const res = await stranger.agent.post(f.runUrl).send({ entrypoint: 'main.py' });

    expect(res.status).toBe(404);
  });

  it('returns 403 for a VIEWER — running code is not reading it', async () => {
    const f = await setup();
    await addFile(f.projectId, 'main.py');
    const viewer = await registerUser(app);
    await addMember(f.projectId, viewer.user.id, 'VIEWER');

    const res = await viewer.agent.post(f.runUrl).send({ entrypoint: 'main.py' });

    expect(res.status).toBe(403);
  });

  it('allows an EDITOR', async () => {
    const f = await setup();
    await addFile(f.projectId, 'main.py');
    const editor = await registerUser(app);
    await addMember(f.projectId, editor.user.id, 'EDITOR');

    const res = await editor.agent.post(f.runUrl).send({ entrypoint: 'main.py' });

    // Reaches the queue rather than being refused. Redis may or may not be up
    // in this environment; either way it is past every guard.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });
});

describe('POST /run — entrypoint validation', () => {
  it('rejects a missing body', async () => {
    const f = await setup();
    const res = await f.owner.agent.post(f.runUrl).send({});

    expect(res.status).toBe(400);
  });

  it('rejects a file type with no runtime', async () => {
    const f = await setup();
    await addFile(f.projectId, 'app.ts', 'const x = 1;\n');

    const res = await f.owner.agent.post(f.runUrl).send({ entrypoint: 'app.ts' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('LANGUAGE_UNSUPPORTED');
  });

  it('rejects an entrypoint that is not in the project', async () => {
    const f = await setup();
    await addFile(f.projectId, 'main.py');

    const res = await f.owner.agent.post(f.runUrl).send({ entrypoint: 'nope.py' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FILE_NOT_FOUND');
  });

  it('rejects a directory as the entrypoint', async () => {
    const f = await setup();
    await addFile(f.projectId, 'src/main.py');

    // `src` is a directory, so it is not among the runnable files.
    const res = await f.owner.agent.post(f.runUrl).send({ entrypoint: 'src' });

    expect(res.status).toBe(400);
  });
});

describe('POST /run — input caps', () => {
  it('rejects a project with more than the file cap', async () => {
    const f = await setup();
    await addFile(f.projectId, 'main.py');
    for (let i = 0; i < MAX_RUN_FILES; i++) {
      await addFile(f.projectId, `f${i}.py`, 'x = 1\n');
    }

    const res = await f.owner.agent.post(f.runUrl).send({ entrypoint: 'main.py' });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('RUN_TOO_LARGE');
  });

  it('rejects a project over the byte cap', async () => {
    const f = await setup();
    await addFile(f.projectId, 'main.py');
    // Two files of 600 KB each: over 1 MB, under the file-count cap.
    await addFile(f.projectId, 'big1.py', 'x'.repeat(600_000));
    await addFile(f.projectId, 'big2.py', 'x'.repeat(600_000));

    const res = await f.owner.agent.post(f.runUrl).send({ entrypoint: 'main.py' });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('RUN_TOO_LARGE');
  });
});

describe('GET /runs/:jobId/stream — job ownership', () => {
  it('404s an unknown jobId rather than hanging', async () => {
    const f = await setup();

    const res = await f.owner.agent.get(
      `/api/projects/${f.projectId}/runs/00000000-0000-4000-8000-000000000000/stream`,
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RUN_NOT_FOUND');
  });

  it('requires EDITOR on the stream too, not just the POST', async () => {
    const f = await setup();
    const viewer = await registerUser(app);
    await addMember(f.projectId, viewer.user.id, 'VIEWER');

    const res = await viewer.agent.get(
      `/api/projects/${f.projectId}/runs/00000000-0000-4000-8000-000000000000/stream`,
    );

    // Authorization is re-checked before the job is even looked up.
    expect(res.status).toBe(403);
  });
});
