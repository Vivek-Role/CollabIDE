import request from 'supertest';
import type { Express } from 'express';
import type TestAgent from 'supertest/lib/agent.js';

/**
 * Fixtures modules 1.3–1.5 build on. A supertest *agent* keeps the session
 * cookie between requests, so it behaves like a signed-in browser.
 */

export interface TestUser {
  id: string;
  email: string;
  displayName: string;
}

export interface SignedInUser {
  agent: TestAgent;
  user: TestUser;
  password: string;
  /** The raw `ce_session=…` pair, for driving an app the agent isn't bound to. */
  cookie: string;
}

function sessionCookieFrom(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const session = list.find((value) => value.startsWith('ce_session='));

  if (!session) throw new Error('No ce_session cookie was set');
  return session.split(';')[0] ?? '';
}

let counter = 0;

export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}${counter}.${Date.now()}@example.com`;
}

export async function registerUser(
  app: Express,
  overrides: Partial<{ email: string; password: string; displayName: string }> = {},
): Promise<SignedInUser> {
  const email = overrides.email ?? uniqueEmail();
  const password = overrides.password ?? 'correct-horse-battery';
  const displayName = overrides.displayName ?? 'Test User';

  const agent = request.agent(app);
  const res = await agent.post('/api/auth/register').send({ email, password, displayName });

  if (res.status !== 201) {
    throw new Error(`registerUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return {
    agent,
    user: res.body.user as TestUser,
    password,
    cookie: sessionCookieFrom(res.headers as Record<string, unknown>),
  };
}
