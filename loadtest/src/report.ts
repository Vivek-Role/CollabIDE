import type { ClientResult, RunConfig } from './config.js';
import type { Environment } from './environment.js';
import type { LatencyStats } from './latency.js';

/**
 * The result blob is the artefact. Module 8.3 renders its table from this file
 * and never retypes a number.
 *
 * Any metric that could not be taken is null WITH a sibling reason — never 0,
 * never omitted. Zero is a measurement; absence is not, and a results table that
 * cannot tell them apart is worse than one with a gap in it.
 */

export interface Measured<T> {
  value: T | null;
  reason?: string;
}

export interface DocOutcome {
  docId: string;
  clients: number;
  expectedLength: number;
  actualLength: number;
  converged: boolean;
}

export interface Blob {
  schema: 1;
  environment: Environment;
  config: RunConfig;
  topology: string;
  window: { startedAt: number; endedAt: number; durationSec: number; warmupSec: number };
  latency: LatencyStats & { docsWithNoPeer: number; markerChars: number };
  resources: {
    serverCpuPercent: Measured<{ mean: number; peak: number; samples: number; pids: number[] }>;
    serverRssMb: Measured<{ mean: number; peak: number; samples: number }>;
    /** The load generator itself (D1) — a ceiling means nothing without it. */
    harnessCpuPercent: Measured<{ mean: number; peak: number; samples: number; pids: number[] }>;
    harnessRssMb: Measured<{ mean: number; peak: number; samples: number }>;
    redis: Measured<{ commandsPerSec: number; totalDelta: number; samplerCommands: number; peakInstantaneousOps: number }>;
    db: Measured<{
      docUpdatesPerSec: number;
      docUpdateDelta: number;
      docSnapshotDelta: number;
      snapshotHighWaterDelta: number;
    }>;
  };
  correctness: { converged: boolean; docs: DocOutcome[]; errors: string[] };
  clients: ClientResult[];
}

const show = (value: number | null, digits = 1): string =>
  value === null ? 'n/a' : value.toFixed(digits);

export function printSummary(blob: Blob): void {
  const { latency, resources } = blob;

  console.log(`\ntopology: ${blob.topology}   window: ${blob.window.durationSec}s (warm-up ${blob.window.warmupSec}s excluded)`);

  console.log('\nlatency (local edit -> remote apply, ms)');
  if (latency.n === 0) {
    console.log('  no samples — a doc needs at least two clients for propagation to exist');
  } else {
    console.log(
      `  p50=${show(latency.p50)}  p95=${show(latency.p95)}  p99=${show(latency.p99)}` +
        `  min=${show(latency.min)}  max=${show(latency.max)}  mean=${show(latency.mean, 2)}`,
    );
    // n travels with every percentile, everywhere. A p99 from 40 samples is
    // labelled as such, and 8.3 may not quote a percentile without it.
    console.log(`  n=${latency.n}  discarded(warm-up)=${latency.discarded}  docsWithNoPeer=${latency.docsWithNoPeer}`);
  }

  console.log('\nresources');
  const cpu = resources.serverCpuPercent;
  console.log(
    cpu.value
      ? `  server CPU%   mean=${cpu.value.mean.toFixed(1)}  peak=${cpu.value.peak.toFixed(1)}  (pids ${cpu.value.pids.join(', ')}, ${cpu.value.samples} samples)`
      : `  server CPU%   not measured — ${cpu.reason ?? 'unknown'}`,
  );

  const rss = resources.serverRssMb;
  console.log(
    rss.value
      ? `  server RSS MB mean=${rss.value.mean.toFixed(1)}  peak=${rss.value.peak.toFixed(1)}`
      : `  server RSS MB not measured — ${rss.reason ?? 'unknown'}`,
  );

  const hcpu = resources.harnessCpuPercent;
  const hrss = resources.harnessRssMb;
  console.log(
    hcpu.value && hrss.value
      ? `  harness CPU%  mean=${hcpu.value.mean.toFixed(1)}  peak=${hcpu.value.peak.toFixed(1)}   RSS MB mean=${hrss.value.mean.toFixed(1)}  peak=${hrss.value.peak.toFixed(1)}`
      : `  harness CPU%  not measured — ${hcpu.reason ?? 'unknown'}`,
  );

  const redis = resources.redis;
  console.log(
    redis.value
      ? `  redis         ${redis.value.commandsPerSec.toFixed(1)} commands/sec (Δ${redis.value.totalDelta}, minus ${redis.value.samplerCommands} of our own)`
      : `  redis         not measured — ${redis.reason ?? 'unknown'}`,
  );

  const db = resources.db;
  console.log(
    db.value
      ? `  db            ${db.value.docUpdatesPerSec.toFixed(1)} DocUpdate rows/sec (Δ${db.value.docUpdateDelta}, snapshots Δ${db.value.docSnapshotDelta}, high-water Δ${db.value.snapshotHighWaterDelta})`
      : `  db            not measured — ${db.reason ?? 'unknown'}`,
  );

  console.log(`\nmarker characters written: ${latency.markerChars} (never removed — decision F1)`);
}
