import { writeFile } from 'node:fs/promises';
import { makeDocId } from '@collab/shared';
import { Worker } from 'node:worker_threads';

import {
  ConfigError,
  parseConfig,
  topologyOf,
  type ClientPlan,
  type ClientResult,
  type RunConfig,
} from './config.js';
import { captureEnvironment } from './environment.js';
import { selfCheck, summarise, type Sample } from './latency.js';
import { printSummary, type Blob, type DocOutcome, type Measured } from './report.js';
import { cpuPercent, openRedis, readDb, readProc, readRedis, type ProcSample } from './resources.js';
import { seed } from './seed.js';

/**
 * Seeds, spawns, samples, aggregates, prints, exits.
 *
 * The main thread does no socket work — that is what makes it safe to sample
 * /proc and Redis from here at 1 Hz without perturbing the clients.
 *
 * Module 8.2 produces numbers; it does not publish any. Nothing printed here
 * goes into a document. The R1–R4 matrix and docs/notes/loadtest-results.md are
 * module 8.3.
 */

const SETTLE_MS = 2000;
const SAMPLE_INTERVAL_MS = 1000;

function planClients(config: RunConfig, projectId: string, fileIds: string[], cookies: string[]): ClientPlan[] {
  const startAt = Date.now() + 250;
  const plans: ClientPlan[] = [];
  const probedDocs = new Set<string>();

  for (let i = 0; i < config.clients; i += 1) {
    const fileId = fileIds[i % fileIds.length];
    const server = config.servers[i % config.servers.length];
    const cookie = cookies[i % cookies.length];
    if (fileId === undefined || server === undefined || cookie === undefined) {
      throw new Error('Assignment produced an empty slot — seeding returned less than it promised');
    }

    const docId = makeDocId(projectId, fileId);
    // The lowest client index on a doc probes; everyone else observes. No role
    // negotiation, no extra client, no extra connection.
    const isProber = !probedDocs.has(docId);
    probedDocs.add(docId);

    plans.push({
      index: i,
      docId,
      server,
      cookie,
      connectAt: startAt + Math.round((i / config.clients) * config.ramp * 1000),
      isProber,
    });
  }
  return plans;
}

function summariseDocs(results: ClientResult[]): DocOutcome[] {
  const byDoc = new Map<string, ClientResult[]>();
  for (const result of results) {
    const list = byDoc.get(result.docId) ?? [];
    list.push(result);
    byDoc.set(result.docId, list);
  }

  return [...byDoc.entries()].map(([docId, group]) => {
    // Markers are never removed, so they are part of the expected length. This
    // keeps the 8.1 convergence bar exact rather than turning it into a
    // tolerance (decision F1).
    const expectedLength = group.reduce((total, one) => total + one.editsSent + one.markerChars, 0);
    const first = group[0];
    const actualLength = first?.textLength ?? 0;

    return {
      docId,
      clients: group.length,
      expectedLength,
      actualLength,
      converged:
        group.every((one) => one.textHash === first?.textHash && one.error === undefined) &&
        actualLength === expectedLength,
    };
  });
}

interface SamplerOutput {
  cpu: number[];
  rssMb: number[];
  harnessCpu: number[];
  harnessRssMb: number[];
}

/**
 * 1 Hz CPU/RSS sampling of the server process(es) AND of this process, from the
 * main thread (which does no socket work, so sampling cannot perturb clients).
 *
 * Measuring ourselves is what makes a ceiling interpretable (module 8.3 decision
 * D1). Everything runs on one 4-processor VM — two servers, Postgres, Redis and
 * a four-thread load generator — so when a climb step fails, the only way to
 * tell "the server saturated" from "our own load generator ran out of CPU" is to
 * have measured both. Reporting the first when it was really the second would be
 * the exact failure this phase exists to avoid.
 *
 * This is NOT server-side instrumentation: apps/server is untouched.
 */
function startResourceSampler(pids: number[], harnessPid: number): () => SamplerOutput {
  const cpu: number[] = [];
  const rssMb: number[] = [];
  const harnessCpu: number[] = [];
  const harnessRssMb: number[] = [];
  let previous: { at: number; samples: (ProcSample | null)[] } | null = null;
  let previousHarness: { at: number; sample: ProcSample | null } | null = null;

  const timer = setInterval(() => {
    void (async () => {
      const at = Date.now();
      const samples = await Promise.all(pids.map((pid) => readProc(pid)));

      if (previous !== null) {
        let total = 0;
        let rss = 0;
        let usable = 0;

        for (const [i, sample] of samples.entries()) {
          const before = previous.samples[i];
          if (!sample || !before) continue;
          total += cpuPercent(before, sample, at - previous.at);
          rss += sample.rssKb / 1024;
          usable += 1;
        }

        if (usable > 0) {
          cpu.push(total);
          rssMb.push(rss);
        }
      }
      previous = { at, samples };

      const harness = await readProc(harnessPid);
      if (previousHarness?.sample && harness) {
        harnessCpu.push(cpuPercent(previousHarness.sample, harness, at - previousHarness.at));
        harnessRssMb.push(harness.rssKb / 1024);
      }
      previousHarness = { at, sample: harness };
    })();
  }, SAMPLE_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    return { cpu, rssMb, harnessCpu, harnessRssMb };
  };
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

async function main(): Promise<number> {
  if (process.argv.includes('--self-check')) {
    selfCheck();
    return 0;
  }

  const config = parseConfig(process.argv.slice(2));
  const topology = topologyOf(config);

  console.log('loadtest 8.2');
  console.log(`  scenario=${config.scenario} topology=${topology} clients=${config.clients} workers=${config.workers} docs=${config.docs}`);
  console.log(`  edits/sec=${config.editsPerSec} probe-hz=${config.probeHz} ramp=${config.ramp}s duration=${config.duration}s warmup=${config.warmup}s`);
  console.log(`  servers=${config.servers.join(', ')}`);

  const environment = await captureEnvironment(topology, process.argv.slice(2).join(' '));
  console.log(`  git=${environment.gitSha?.slice(0, 7) ?? 'n/a'}${environment.gitDirty ? '-dirty' : ''} node=${environment.node} cpus=${environment.cpuCount}`);

  const seeded = await seed(config);
  const docIds = seeded.fileIds.map((fileId) => makeDocId(seeded.projectId, fileId));
  console.log(`  seeded project ${seeded.projectId} with ${seeded.fileIds.length} file(s)\n`);

  const plans = planClients(config, seeded.projectId, seeded.fileIds, seeded.cookies);
  const rampEndsAt = Math.max(...plans.map((plan) => plan.connectAt)) + 500;
  const typeEndAt = rampEndsAt + config.duration * 1000;

  // Redis and DB are before/after deltas taken around the measured window.
  let redis: Awaited<ReturnType<typeof openRedis>> | null = null;
  let redisBefore = null;
  let redisReason: string | undefined;
  let samplerCommands = 0;

  try {
    redis = await openRedis(config.redisUrl);
    redisBefore = await readRedis(redis);
    samplerCommands += 1;
  } catch (error) {
    redisReason = `could not read Redis INFO: ${error instanceof Error ? error.message : String(error)}`;
  }

  let dbBefore = null;
  let dbReason: string | undefined;
  if (config.databaseUrl === undefined) {
    dbReason = 'no --database-url and no DATABASE_URL in the environment';
  } else {
    try {
      dbBefore = await readDb(config.databaseUrl, docIds);
    } catch (error) {
      dbReason = `could not read Postgres: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const stopSampler = startResourceSampler(config.serverPids, process.pid);

  const workers: Worker[] = [];
  const collected: ClientResult[] = [];
  let failed: string | undefined;
  const startedAt = Date.now();

  const finished = Array.from({ length: config.workers }, (_, w) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: {
        clients: plans.filter((plan) => plan.index % config.workers === w),
        editsPerSec: config.editsPerSec,
        probeHz: config.probeHz,
        typeStartAt: rampEndsAt,
        typeEndAt,
        settleMs: SETTLE_MS,
      },
    });
    workers.push(worker);

    worker.on('message', (message: { type: string; results?: ClientResult[]; message?: string }) => {
      if (message.type === 'done' && message.results) collected.push(...message.results);
      if (message.type === 'failed') failed = message.message ?? 'worker failed';
    });

    return new Promise<void>((resolve, reject) => {
      worker.on('error', reject);
      worker.on('exit', (exitCode) => {
        if (exitCode === 0) resolve();
        else reject(new Error(`worker ${w} exited with ${exitCode}`));
      });
    });
  });

  const abort = (): void => {
    for (const worker of workers) void worker.terminate();
    process.exitCode = 130;
  };
  process.on('SIGINT', abort);

  await Promise.all(finished);
  process.off('SIGINT', abort);

  const endedAt = Date.now();
  const { cpu, rssMb, harnessCpu, harnessRssMb } = stopSampler();

  if (failed !== undefined) {
    console.error(`\nFAIL: ${failed}`);
    if (redis) redis.disconnect();
    return 1;
  }

  const measuredSeconds = (typeEndAt - rampEndsAt) / 1000;

  let redisAfter = null;
  if (redis && redisBefore) {
    try {
      redisAfter = await readRedis(redis);
      samplerCommands += 1;
    } catch (error) {
      redisReason = `could not read Redis INFO: ${error instanceof Error ? error.message : String(error)}`;
    }
    redis.disconnect();
  }

  let dbAfter = null;
  if (config.databaseUrl !== undefined && dbBefore) {
    try {
      dbAfter = await readDb(config.databaseUrl, docIds);
    } catch (error) {
      dbReason = `could not read Postgres: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // ── latency ───────────────────────────────────────────────────────────────
  const samples: Sample[] = collected.flatMap((one) => one.samples);
  const stats = summarise(samples, rampEndsAt + config.warmup * 1000);

  const outcomes = summariseDocs(collected);
  const errors = collected.filter((one) => one.error !== undefined);
  const clientsPerDoc = new Map<string, number>();
  for (const one of collected) clientsPerDoc.set(one.docId, (clientsPerDoc.get(one.docId) ?? 0) + 1);

  const cpuValue: Measured<{ mean: number; peak: number; samples: number; pids: number[] }> =
    config.serverPids.length === 0
      ? { value: null, reason: 'no --server-pid given' }
      : cpu.length === 0
        ? { value: null, reason: `no readable /proc data for pid(s) ${config.serverPids.join(', ')}` }
        : { value: { mean: mean(cpu), peak: Math.max(...cpu), samples: cpu.length, pids: config.serverPids } };

  const blob: Blob = {
    schema: 1,
    environment,
    config,
    topology,
    window: {
      startedAt,
      endedAt,
      durationSec: measuredSeconds,
      warmupSec: config.warmup,
    },
    latency: {
      ...stats,
      docsWithNoPeer: [...clientsPerDoc.values()].filter((count) => count < 2).length,
      markerChars: collected.reduce((total, one) => total + one.markerChars, 0),
    },
    resources: {
      serverCpuPercent: cpuValue,
      serverRssMb:
        rssMb.length === 0
          ? { value: null, reason: cpuValue.reason ?? 'no RSS samples' }
          : { value: { mean: mean(rssMb), peak: Math.max(...rssMb), samples: rssMb.length } },
      // D1: the load generator measured on the same terms as the thing it
      // measures, so a ceiling can be attributed to one or the other.
      harnessCpuPercent:
        harnessCpu.length === 0
          ? { value: null, reason: 'no readable /proc data for this process' }
          : {
              value: {
                mean: mean(harnessCpu),
                peak: Math.max(...harnessCpu),
                samples: harnessCpu.length,
                pids: [process.pid],
              },
            },
      harnessRssMb:
        harnessRssMb.length === 0
          ? { value: null, reason: 'no readable /proc data for this process' }
          : {
              value: {
                mean: mean(harnessRssMb),
                peak: Math.max(...harnessRssMb),
                samples: harnessRssMb.length,
              },
            },
      redis:
        redisBefore && redisAfter
          ? {
              value: {
                // The sampler's own INFO calls are subtracted: it must not count
                // itself in the number it reports.
                totalDelta: redisAfter.totalCommands - redisBefore.totalCommands - samplerCommands,
                commandsPerSec:
                  (redisAfter.totalCommands - redisBefore.totalCommands - samplerCommands) / measuredSeconds,
                samplerCommands,
                peakInstantaneousOps: Math.max(redisBefore.instantaneousOps, redisAfter.instantaneousOps),
              },
            }
          : { value: null, reason: redisReason ?? 'Redis not sampled' },
      db:
        dbBefore && dbAfter
          ? {
              value: {
                docUpdateDelta: dbAfter.docUpdates - dbBefore.docUpdates,
                docUpdatesPerSec: (dbAfter.docUpdates - dbBefore.docUpdates) / measuredSeconds,
                docSnapshotDelta: dbAfter.docSnapshots - dbBefore.docSnapshots,
                snapshotHighWaterDelta: dbAfter.snapshotHighWater - dbBefore.snapshotHighWater,
              },
            }
          : { value: null, reason: dbReason ?? 'database not sampled' },
    },
    correctness: {
      converged: errors.length === 0 && outcomes.length > 0 && outcomes.every((one) => one.converged),
      docs: outcomes,
      errors: errors.map((one) => `client ${one.index}: ${one.error ?? ''}`),
    },
    clients: collected,
  };

  console.log('doc                                      clients  expected  actual  converged');
  for (const outcome of outcomes) {
    console.log(
      `${outcome.docId.padEnd(40)} ${String(outcome.clients).padStart(7)} ${String(outcome.expectedLength).padStart(9)} ${String(outcome.actualLength).padStart(7)}  ${outcome.converged ? 'yes' : 'NO'}`,
    );
  }
  for (const message of blob.correctness.errors) console.error(`  ${message}`);

  printSummary(blob);
  console.log(`\n${blob.correctness.converged ? 'PASS' : 'FAIL'} — ${collected.length} client(s), ${outcomes.length} doc(s)`);

  if (config.out !== undefined) {
    await writeFile(config.out, `${JSON.stringify(blob, null, 2)}\n`);
    console.log(`wrote ${config.out}`);
  }

  return blob.correctness.converged ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof ConfigError) console.error(`bad flags: ${error.message}`);
    else console.error(error);
    process.exitCode = 1;
  },
);
