import { parseArgs } from 'node:util';

import type { Sample } from './latency.js';

/**
 * Flags in, a validated plan out. Nothing here connects to anything.
 *
 * parseArgs is a Node built-in, so the harness has no argument-parsing
 * dependency — and the flag string the operator typed IS the reproducibility
 * record that module 8.3 pastes beside every measured number. That is why every
 * resolved value is echoed back out in the run summary rather than being kept
 * implicit.
 *
 * Module 8.1 measures nothing. There are no timing flags here on purpose.
 */

export type Scenario = 'distributed' | 'hot-doc';

export interface RunConfig {
  clients: number;
  workers: number;
  docs: number;
  editsPerSec: number;
  duration: number;
  ramp: number;
  servers: string[];
  scenario: Scenario;
  out: string | undefined;
  users: number;
  /** Markers per second, per document (module 8.2). */
  probeHz: number;
  /** Seconds of steady state discarded before latency is measured. */
  warmup: number;
  /** One pid per --servers entry. Empty means CPU/RSS go unmeasured. */
  serverPids: number[];
  redisUrl: string;
  databaseUrl: string | undefined;
}

/** 1-instance or 2-instance. Labelled on every result, because two instances
 *  genuinely persist the same room twice and the number means something
 *  different. */
export function topologyOf(config: RunConfig): string {
  return `${config.servers.length}-instance`;
}

/** One client's whole assignment, decided in the main thread so round-robin
 *  lives in exactly one place and a worker never chooses anything. */
export interface ClientPlan {
  index: number;
  docId: string;
  server: string;
  cookie: string;
  /** Epoch ms. Staggered across the ramp so N sockets never arrive in one tick. */
  connectAt: number;
  /** The lowest client index on this doc probes; everyone else observes. */
  isProber: boolean;
}

/** What a worker is handed. Absolute epoch timestamps, so every thread agrees
 *  on when the ramp ends without a clock of its own. */
export interface WorkerInput {
  clients: ClientPlan[];
  editsPerSec: number;
  probeHz: number;
  typeStartAt: number;
  typeEndAt: number;
  settleMs: number;
}

/** What a worker reports back, once, at the end. */
export interface ClientResult {
  index: number;
  docId: string;
  editsSent: number;
  /**
   * Characters this client contributed as latency markers. Markers are never
   * removed (decision F1), so the convergence expectation is
   * `Σ editsSent + Σ markerChars` — exact, rather than a tolerance.
   */
  markerChars: number;
  /** Latency observations this client made. Shipped once, in `done`. */
  samples: Sample[];
  textLength: number;
  /** Cheap stand-in for the text itself: shipping 200 full documents across
   *  thread boundaries would measure the harness, not the server. */
  textHash: string;
  closeCode: number;
  error: string | undefined;
}

const SCENARIOS = new Set<Scenario>(['distributed', 'hot-doc']);

/** Docs are scenario-dependent, so the default cannot live in the flag table.
 *  hot-doc IS --docs 1; there is no separate code path anywhere. */
const DOCS_BY_SCENARIO: Record<Scenario, number> = { 'hot-doc': 1, distributed: 10 };

export class ConfigError extends Error {}

function integer(raw: string | undefined, fallback: number, name: string, min: number): number {
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`--${name} must be an integer >= ${min} (got "${raw}")`);
  }
  return value;
}

export function parseConfig(argv: string[]): RunConfig {
  let values: Record<string, string | undefined>;

  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        clients: { type: 'string' },
        workers: { type: 'string' },
        docs: { type: 'string' },
        'edits-per-sec': { type: 'string' },
        duration: { type: 'string' },
        ramp: { type: 'string' },
        servers: { type: 'string' },
        scenario: { type: 'string' },
        out: { type: 'string' },
        users: { type: 'string' },
        'probe-hz': { type: 'string' },
        warmup: { type: 'string' },
        'server-pid': { type: 'string' },
        'redis-url': { type: 'string' },
        'database-url': { type: 'string' },
      },
      strict: true,
    }) as { values: Record<string, string | undefined> });
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }

  const scenarioRaw = values['scenario'] ?? 'distributed';
  if (!SCENARIOS.has(scenarioRaw as Scenario)) {
    throw new ConfigError(`--scenario must be one of: ${[...SCENARIOS].join(', ')}`);
  }
  const scenario = scenarioRaw as Scenario;

  const clients = integer(values['clients'], 10, 'clients', 1);
  const servers = (values['servers'] ?? 'http://localhost:4000')
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => entry.length > 0);

  if (servers.length === 0) throw new ConfigError('--servers needs at least one URL');

  for (const server of servers) {
    if (!server.startsWith('http://') && !server.startsWith('https://')) {
      throw new ConfigError(`--servers entries must be http(s) URLs (got "${server}")`);
    }
  }

  const users = integer(values['users'], 1, 'users', 1);
  if (users > clients) throw new ConfigError('--users must not exceed --clients');

  const duration = integer(values['duration'], 60, 'duration', 1);
  const warmup = integer(values['warmup'], 5, 'warmup', 0);
  if (warmup >= duration) {
    throw new ConfigError(`--warmup (${warmup}s) must be less than --duration (${duration}s)`);
  }

  const serverPids = (values['server-pid'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid < 1) {
        throw new ConfigError(`--server-pid must be integer pids (got "${entry}")`);
      }
      return pid;
    });

  if (serverPids.length > 0 && serverPids.length !== servers.length) {
    throw new ConfigError(
      `--server-pid needs one pid per --servers entry (${servers.length}), or none at all`,
    );
  }

  return {
    clients,
    // Clamped rather than rejected: --clients 2 with the default 4 workers is a
    // perfectly reasonable thing to type, and failing it would be pedantry.
    workers: Math.min(integer(values['workers'], 4, 'workers', 1), clients),
    docs: integer(values['docs'], DOCS_BY_SCENARIO[scenario], 'docs', 1),
    editsPerSec: integer(values['edits-per-sec'], 2, 'edits-per-sec', 1),
    duration,
    ramp: integer(values['ramp'], 10, 'ramp', 0),
    servers,
    scenario,
    out: values['out'],
    users,
    probeHz: integer(values['probe-hz'], 1, 'probe-hz', 1),
    warmup,
    serverPids,
    redisUrl: values['redis-url'] ?? 'redis://localhost:6379',
    // Never invented: absent means the DB metrics are recorded as unmeasured.
    databaseUrl: values['database-url'] ?? process.env['DATABASE_URL'],
  };
}
