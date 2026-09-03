import { fileURLToPath } from 'node:url';

/**
 * The runner's configuration, parsed once at import.
 *
 * Deliberately not zod: the runner has one variable and no zod dependency, and
 * a schema for a single URL would be ceremony. apps/server's config.ts uses zod
 * because it validates seven values including a secret whose absence must crash
 * the boot.
 *
 * Resolution order, the same rule apps/server follows:
 *
 *   1. an explicitly-set REDIS_URL   (what CI or a test harness would use)
 *   2. apps/runner/.env
 *   3. the built-in default
 *
 * Note that .env.example tells you to copy it to apps/server/.env, so on a
 * normal checkout apps/runner/.env does NOT exist and the default below is the
 * live path. That is fine — it matches infra/docker-compose.yml exactly, so the
 * runner starts on a clean clone with no configuration at all. The trap worth
 * knowing: changing REDIS_PORT moves the server and leaves the runner here, so
 * export REDIS_URL for the runner too. .env.example says so.
 */

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

if (!process.env.REDIS_URL) {
  try {
    // Node 24 builtin — deliberately no dotenv dependency.
    process.loadEnvFile(ENV_FILE);
  } catch {
    // No .env file: the ambient environment and the default carry it.
  }
}

export const config = Object.freeze({
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
});

export type Config = typeof config;
