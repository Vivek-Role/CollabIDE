import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/**
 * The environment is parsed exactly once, at import time, and the process
 * refuses to start if it is wrong. A missing JWT_SECRET should crash on boot
 * with a readable message — not produce a 500 on the first login three days
 * from now.
 *
 * Rule: an explicitly-set environment variable always beats the .env file.
 * That is what lets the test harness point at collab_editor_test, and what lets
 * CI inject real secrets. prisma.config.ts follows the same rule.
 */

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

if (!process.env.DATABASE_URL) {
  try {
    // Node 24 builtin — deliberately no dotenv dependency.
    process.loadEnvFile(ENV_FILE);
  } catch {
    // No .env file: the ambient environment is expected to carry everything.
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /**
   * Unused until module 1.2 signs its first token, but validated now: the point
   * of boot-time validation is that the failure happens here, not at login.
   */
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  /**
   * The single allowed browser origin. In dev the Vite server proxies /api to
   * this process, so requests arrive same-origin (see CLAUDE.md) — this is the
   * belt to that proxy's braces.
   */
  WEB_ORIGIN: z.string().min(1).default('http://localhost:5173'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new Error(
    `Invalid server environment:\n${details}\n\n` +
      'Copy .env.example to apps/server/.env and fill it in.',
  );
}

export const config = Object.freeze({
  nodeEnv: parsed.data.NODE_ENV,
  port: parsed.data.PORT,
  databaseUrl: parsed.data.DATABASE_URL,
  jwtSecret: parsed.data.JWT_SECRET,
  webOrigin: parsed.data.WEB_ORIGIN,
  isProduction: parsed.data.NODE_ENV === 'production',
});

export type Config = typeof config;
