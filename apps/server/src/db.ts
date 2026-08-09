import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { config } from './config.js';

/**
 * The only place in the process where a PrismaClient is constructed — one pg
 * pool, shared.
 *
 * Prisma 7 removed `url` from the datasource block: the CLI reads it from
 * prisma.config.ts, and the runtime requires a driver adapter instead. That is
 * why this file exists at all, and why module 1.1b had to precede 1.2.
 *
 * Invariant (CLAUDE.md): only apps/server may import this. apps/runner reads
 * plain text from File.content, materialized by module 4.4, and never touches
 * the database.
 */

const adapter = new PrismaPg({ connectionString: config.databaseUrl });

export const prisma = new PrismaClient({
  adapter,
  log: config.nodeEnv === 'development' ? ['warn', 'error'] : ['error'],
});

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
