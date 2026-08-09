import type { CookieOptions } from 'express';
import { SignJWT, jwtVerify } from 'jose';

import { config } from '../../config.js';

/**
 * Session tokens, and the cookie that carries them.
 *
 * The JWT travels in an httpOnly cookie, so no JavaScript on the page can read
 * it. That also means module 3.2's WebSocket upgrade needs no `?token=` query
 * parameter — the browser attaches the cookie to the upgrade request itself,
 * and the token never appears in a URL or a proxy log.
 *
 * jose rather than jsonwebtoken: ESM-native and dependency-free, which matters
 * under this repo's `verbatimModuleSyntax` + NodeNext setup.
 */

export const SESSION_COOKIE = 'ce_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

const secret = new TextEncoder().encode(config.jwtSecret);
const ALG = 'HS256';

export interface SessionClaims {
  userId: string;
  email: string;
}

export async function signToken(claims: SessionClaims): Promise<string> {
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret);
}

/** Throws if the token is expired, tampered with, or signed by another key. */
export async function verifyToken(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] });

  const userId = payload.sub;
  const email = payload['email'];

  if (typeof userId !== 'string' || typeof email !== 'string') {
    throw new Error('Session token is missing its subject or email claim');
  }
  return { userId, email };
}

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    // Blocks the cookie on cross-site requests, which is most of CSRF handled.
    // Dev works because Vite proxies /api to this process, so the browser sees
    // one origin (see CLAUDE.md).
    sameSite: 'strict',
    secure: config.isProduction,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS * 1000, // express wants milliseconds
  };
}
