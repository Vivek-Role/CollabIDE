import { fileURLToPath } from 'node:url';

/**
 * Derives the test database URL from the dev one.
 *
 * Tests get their own database on the same Postgres container — never the dev
 * one. Every destructive helper re-checks the `_test` suffix before it runs, so
 * a misconfiguration cannot quietly wipe your work.
 */

const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));

function baseDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(ENV_FILE);
    } catch {
      // Fall through to the explicit error below.
    }
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set and apps/server/.env was not found — copy .env.example first.',
    );
  }
  return url;
}

/** Idempotent: passing an already-`_test` URL returns it unchanged. */
export function testDatabaseUrl(): string {
  const url = new URL(baseDatabaseUrl());
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));

  if (!name.endsWith('_test')) {
    url.pathname = `/${name}_test`;
  }
  return url.toString();
}

export function databaseNameOf(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
}
