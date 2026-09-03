import { readFile } from 'node:fs/promises';

import { Redis } from 'ioredis';
import { Client } from 'pg';

/**
 * Everything measured from OUTSIDE the server process.
 *
 * apps/server gains no counters, no timing middleware and no metrics endpoint
 * for this — it is measured exactly as commit 09b4c3f left it. Anything that
 * cannot be read from outside is recorded as unmeasured rather than obtained by
 * changing the thing being measured.
 *
 * Every sampler here runs in the MAIN thread, which does no socket work, so
 * measurement cannot perturb the clients.
 */

/** sysconf(_SC_CLK_TCK). 100 on Linux, and no Node API exposes it. */
const CLOCK_TICKS = 100;

export interface ProcSample {
  jiffies: number;
  rssKb: number;
}

/**
 * Reads CPU jiffies and RSS for one pid.
 *
 * The offset arithmetic is the trap here: field 2 of /proc/<pid>/stat is the
 * process name, it is parenthesised, and it can contain spaces — so splitting
 * on whitespace from the start silently misreads every later field. Everything
 * must be counted after the LAST ')'.
 */
export async function readProc(pid: number): Promise<ProcSample | null> {
  try {
    const [stat, status] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/status`, 'utf8'),
    ]);

    // After the last ')' the next field is 3 (state), so field N is index N-3.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);

    const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
    if (!Number.isFinite(utime) || !Number.isFinite(stime) || !rss?.[1]) return null;

    return { jiffies: utime + stime, rssKb: Number(rss[1]) };
  } catch {
    // The process exited, or the pid was never right. Reported as unmeasured.
    return null;
  }
}

export function cpuPercent(before: ProcSample, after: ProcSample, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return ((after.jiffies - before.jiffies) / CLOCK_TICKS / (elapsedMs / 1000)) * 100;
}

// ── Redis ───────────────────────────────────────────────────────────────────

export interface RedisCounters {
  totalCommands: number;
  instantaneousOps: number;
}

function infoValue(info: string, key: string): number {
  const match = new RegExp(`^${key}:(\\d+)`, 'm').exec(info);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

export async function openRedis(url: string): Promise<Redis> {
  const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();
  return redis;
}

export async function readRedis(redis: Redis): Promise<RedisCounters> {
  const info = await redis.info('stats');
  return {
    totalCommands: infoValue(info, 'total_commands_processed'),
    instantaneousOps: infoValue(info, 'instantaneous_ops_per_sec'),
  };
}

// ── Postgres ────────────────────────────────────────────────────────────────

export interface DbCounts {
  docUpdates: number;
  docSnapshots: number;
  /** Highest DocUpdate.id folded into a snapshot, across this run's docs. */
  snapshotHighWater: number;
}

/**
 * Counted through `pg`, never Prisma: CLAUDE.md's invariant is that Prisma is
 * imported only in apps/server, and this workspace is not apps/server.
 *
 * Scoped to this run's doc ids so rows left by earlier runs cannot contaminate
 * the delta. The models carry no @@map, so the tables are the quoted
 * identifiers "DocUpdate" and "DocSnapshot".
 */
export async function readDb(connectionString: string, docIds: string[]): Promise<DbCounts> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    const updates = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM "DocUpdate" WHERE "docId" = ANY($1)',
      [docIds],
    );
    const snapshots = await client.query<{ n: string; high: string }>(
      'SELECT count(*)::text AS n, coalesce(max("updateId"), 0)::text AS high FROM "DocSnapshot" WHERE "docId" = ANY($1)',
      [docIds],
    );

    return {
      docUpdates: Number(updates.rows[0]?.n ?? 0),
      docSnapshots: Number(snapshots.rows[0]?.n ?? 0),
      // DocSnapshot.docId is @unique and every opened document is snapshotted
      // immediately, so the ROW COUNT cannot show compaction — the row already
      // exists and is replaced in place. This high-water mark is what actually
      // moves when compaction folds more updates in.
      snapshotHighWater: Number(snapshots.rows[0]?.high ?? 0),
    };
  } finally {
    await client.end();
  }
}
