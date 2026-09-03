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
  /**
   * Where the execution queue and the run-output channels live (module 6.6).
   *
   * Defaulted rather than required on purpose: the test harness never sets it,
   * and buildApp() must keep booting without Redis. Nothing connects at import
   * time — modules/execution creates its queue lazily, on the first real run.
   */
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  /**
   * Whether the collaboration fan-out also goes over Redis (module 7.1).
   *
   * Defaults to on everywhere except tests. The suite drives real rooms through
   * real sockets (collab.test.ts) and runs today with Redis down; subscribing
   * from those tests would open connections that are not there and leave handles
   * that can stop Vitest exiting. modules/redis is NOT gated by this — only the
   * two call sites in collab/syncHandler.ts are, so docBus.test.ts still
   * exercises the real bus.
   *
   * It controls nothing else. It is not a feature switch.
   */
  DOC_BUS_ENABLED: z.enum(['true', 'false']).optional(),
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
  redisUrl: parsed.data.REDIS_URL,
  docBusEnabled:
    parsed.data.DOC_BUS_ENABLED === undefined
      ? parsed.data.NODE_ENV !== 'test'
      : parsed.data.DOC_BUS_ENABLED === 'true',
  isProduction: parsed.data.NODE_ENV === 'production',
});

export type Config = typeof config;
