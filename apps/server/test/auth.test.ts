import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp } from './helpers/app.js';
import { registerUser, uniqueEmail } from './helpers/auth.js';
import { prisma, resetDb } from './helpers/db.js';

const app = createTestApp();

const PASSWORD = 'correct-horse-battery';

function cookieHeader(res: request.Response): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.join('; ');
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('register', () => {
  it('creates a user, returns it, and sets a hardened session cookie', async () => {
    const email = uniqueEmail();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: PASSWORD, displayName: 'Ada' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email, displayName: 'Ada' });
    expect(res.body.user.id).toEqual(expect.any(String));

    const cookie = cookieHeader(res);
    expect(cookie).toContain('ce_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('never returns passwordHash', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: uniqueEmail(), password: PASSWORD, displayName: 'Ada' });

    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('scrypt$');
  });

  it('stores the password only as a scrypt hash', async () => {
    const email = uniqueEmail();
    await request(app)
      .post('/api/auth/register')
      .send({ email, password: PASSWORD, displayName: 'Ada' });

    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(row.passwordHash).not.toContain(PASSWORD);
    expect(row.passwordHash.startsWith('scrypt$')).toBe(true);
  });

  it('rejects a duplicate email with 409', async () => {
    const email = uniqueEmail();
    const body = { email, password: PASSWORD, displayName: 'Ada' };

    await request(app).post('/api/auth/register').send(body).expect(201);
    const res = await request(app).post('/api/auth/register').send(body);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('treats email as case-insensitive', async () => {
    const email = uniqueEmail();

    await request(app)
      .post('/api/auth/register')
      .send({ email: email.toUpperCase(), password: PASSWORD, displayName: 'Ada' })
      .expect(201);

    const duplicate = await request(app)
      .post('/api/auth/register')
      .send({ email, password: PASSWORD, displayName: 'Ada' });

    expect(duplicate.status).toBe(409);

    // ...and it was normalized on the way in.
    const stored = await prisma.user.findUnique({ where: { email } });
    expect(stored).not.toBeNull();
  });

  it('rejects a password under 10 characters', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: uniqueEmail(), password: 'short', displayName: 'Ada' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a malformed email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: PASSWORD, displayName: 'Ada' });

    expect(res.status).toBe(400);
  });
});

describe('login', () => {
  it('signs in with the right password', async () => {
    const { user } = await registerUser(app, { password: PASSWORD });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(cookieHeader(res)).toContain('ce_session=');
  });

  it('accepts a differently-cased email', async () => {
    const { user } = await registerUser(app, { password: PASSWORD });

    await request(app)
      .post('/api/auth/login')
      .send({ email: user.email.toUpperCase(), password: PASSWORD })
      .expect(200);
  });

  it('returns the same 401 for a wrong password and an unknown email', async () => {
    const { user } = await registerUser(app, { password: PASSWORD });

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'definitely-not-it' });

    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: uniqueEmail('ghost'), password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // Byte-identical: nothing here says which account exists.
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('sets no cookie on a failed login', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: uniqueEmail('ghost'), password: PASSWORD });

    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('me', () => {
  it('returns the signed-in user', async () => {
    const { agent, user } = await registerUser(app);

    const res = await agent.get('/api/auth/me');

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, email: user.email });
  });

  it('is 401 without a cookie', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('is 401 for a tampered token', async () => {
    const { agent } = await registerUser(app);

    // Flip the last character of the signature.
    const good = await agent.get('/api/auth/me').expect(200);
    expect(good.status).toBe(200);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', 'ce_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bogus-signature');

    expect(res.status).toBe(401);
  });

  it('is 401 for a token signed with a different secret', async () => {
    // A structurally valid JWT that this server never issued.
    const foreign =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiJhdHRhY2tlciIsImVtYWlsIjoiYUB4LmNvbSIsImV4cCI6NDEwMjQ0NDgwMH0.' +
      'ZmFrZXNpZ25hdHVyZWZha2VzaWduYXR1cmVmYWtlcw';

    const res = await request(app).get('/api/auth/me').set('Cookie', `ce_session=${foreign}`);

    expect(res.status).toBe(401);
  });

  it('is 401 after the user row is deleted, even with a valid token', async () => {
    const { agent, user } = await registerUser(app);
    await prisma.user.delete({ where: { id: user.id } });

    const res = await agent.get('/api/auth/me');

    expect(res.status).toBe(401);
  });
});

describe('logout', () => {
  it('clears the session', async () => {
    const { agent } = await registerUser(app);
    await agent.get('/api/auth/me').expect(200);

    const res = await agent.post('/api/auth/logout');
    expect(res.status).toBe(204);

    const after = await agent.get('/api/auth/me');
    expect(after.status).toBe(401);
  });
});
