import { prisma } from '../../src/db.js';
import { databaseNameOf } from './env.js';

/**
 * Per-test cleanup. Ordering does not matter because of CASCADE, but the list
 * is written child-first anyway so it still reads correctly if the cascade is
 * ever removed.
 */
const TABLES = ['DocSnapshot', 'DocUpdate', 'File', 'ProjectMember', 'Project', 'User'] as const;

export async function resetDb(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set in the test environment.');

  // The guard that makes truncating safe: re-checked on every single call,
  // not just at setup, because a stray env change mid-run must not wipe dev data.
  const name = databaseNameOf(url);
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to truncate "${name}" — the test database name must end in _test.`);
  }

  const list = TABLES.map((table) => `"${table}"`).join(', ');
  await prisma.$executeRawUnsafe(`truncate table ${list} restart identity cascade`);
}

export { prisma };
