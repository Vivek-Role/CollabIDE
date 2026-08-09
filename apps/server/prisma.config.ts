import { fileURLToPath } from 'node:url';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 moved the datasource URL out of schema.prisma and into this file.
 * Only the CLI (migrate / introspect / studio) reads it — the runtime client
 * gets its connection through a driver adapter instead, wired up in 1.2.
 *
 * Prisma 7 also stopped auto-loading .env, so we load it ourselves. Node 24 has
 * this built in, so there is no dotenv dependency. Resolved relative to this
 * file rather than cwd, so the CLI works from the repo root too.
 *
 * A missing .env is not fatal: CI and production supply DATABASE_URL directly
 * through the real environment.
 */
// An explicitly-set DATABASE_URL always wins over the .env file — that is what
// lets the test harness point `migrate deploy` at collab_editor_test, and what
// lets CI inject the real one. src/config.ts follows the same rule.
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)));
  } catch {
    // No .env file — fall back to the ambient environment.
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
