import { Router } from 'express';

import { prisma } from '../../db.js';
import { AppError } from '../../http/errors.js';
import { burnVerificationTime, hashPassword, verifyPassword } from './password.js';
import { currentUser, requireAuth } from './requireAuth.js';
import { loginSchema, registerSchema } from './schemas.js';
import { SESSION_COOKIE, sessionCookieOptions, signToken } from './token.js';

/**
 * POST /api/auth/register · POST /api/auth/login · POST /api/auth/logout ·
 * GET /api/auth/me
 *
 * Handlers are plain async functions with no try/catch: Express 5 forwards a
 * rejected promise to the error middleware, and ZodError / Prisma P2002 are
 * already mapped there.
 */

interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
}

/** The only shape a user is ever serialized in. passwordHash is not a field
 *  here, so it cannot leak by accident from a new route later. */
function toPublicUser(user: PublicUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
  };
}

const PUBLIC_FIELDS = {
  id: true,
  email: true,
  displayName: true,
  createdAt: true,
} as const;

/** Identical for "no such email" and "wrong password" — the client must not be
 *  able to tell which, or it can enumerate accounts. */
const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');

export const authRouter: Router = Router();

authRouter.post('/register', async (req, res) => {
  const { email, password, displayName } = registerSchema.parse(req.body);

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    throw new AppError(409, 'EMAIL_TAKEN', 'That email is already registered');
  }

  const passwordHash = await hashPassword(password);

  // The unique index is still the real guard: two simultaneous registrations
  // both pass the check above, and the loser surfaces as P2002 -> 409.
  const user = await prisma.user.create({
    data: { email, passwordHash, displayName },
    select: PUBLIC_FIELDS,
  });

  const token = await signToken({ userId: user.id, email: user.email });
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
  res.status(201).json({ user: toPublicUser(user) });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const user = await prisma.user.findUnique({
    where: { email },
    select: { ...PUBLIC_FIELDS, passwordHash: true },
  });

  if (!user) {
    // Spend the same time a real verification would, then fail identically.
    await burnVerificationTime();
    throw invalidCredentials();
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    throw invalidCredentials();
  }

  const token = await signToken({ userId: user.id, email: user.email });
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
  res.json({ user: toPublicUser(user) });
});

authRouter.post('/logout', (_req, res) => {
  // Same flags as when it was set, minus maxAge — otherwise the browser treats
  // it as a different cookie and quietly keeps the old one.
  const { maxAge: _ignored, ...options } = sessionCookieOptions();
  res.clearCookie(SESSION_COOKIE, options);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const { id } = currentUser(req);

  const user = await prisma.user.findUniqueOrThrow({
    where: { id },
    select: PUBLIC_FIELDS,
  });

  res.json({ user: toPublicUser(user) });
});
