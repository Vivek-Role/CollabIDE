import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { databaseNameOf, testDatabaseUrl } from './env.js';

/**
 * Runs once, before any test file: creates collab_editor_test if it is missing
 * and brings it up to the current migration.
 *
 * `migrate deploy`, not `migrate dev` — deploy only applies existing migrations
 * and never generates one, so a test run can't invent a migration behind your
 * back.
 */

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));

export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const dbName = databaseNameOf(url);

  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${dbName}" — the name must end in _test.`);
  }

  // Connect to the default database to create ours; you cannot create a
  // database from inside itself.
  const admin = new URL(url);
  admin.pathname = '/postgres';

  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const existing = await client.query('select 1 from pg_database where datname = $1', [dbName]);
    if (existing.rowCount === 0) {
      // Identifier, not a value — cannot be parameterized. dbName is derived
      // from our own .env and suffix-checked above.
      await client.query(`create database "${dbName}"`);
      console.log(`[test] created database ${dbName}`);
    }
  } finally {
    await client.end();
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
