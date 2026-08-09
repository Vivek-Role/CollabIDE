import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp } from './helpers/app.js';
import { prisma, resetDb } from './helpers/db.js';
import { databaseNameOf } from './helpers/env.js';

const app = createTestApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('server foundation', () => {
  it('runs against a database whose name ends in _test', () => {
    expect(databaseNameOf(process.env.DATABASE_URL ?? '')).toMatch(/_test$/);
  });

  it('serves /health off a live database', async () => {
    // Proves the Prisma 7 driver adapter is wired: /health issues a real query.
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns the standard error envelope for an unknown route', async () => {
    const res = await request(app).get('/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  it('rejects a mutating request from a foreign origin', async () => {
    const res = await request(app).post('/health').set('Origin', 'https://evil.example');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BAD_ORIGIN');
  });

  it('allows a mutating request with no Origin header', async () => {
    // curl and server-to-server callers send no Origin — they must not be
    // blocked. This one falls through to the 404 handler.
    const res = await request(app).post('/does-not-exist');

    expect(res.status).toBe(404);
  });

  it('never leaks a stack trace', async () => {
    const res = await request(app).get('/does-not-exist');

    expect(JSON.stringify(res.body)).not.toContain('at ');
  });
});
