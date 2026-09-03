import assert from 'node:assert/strict';

/**
 * Propagation latency: local edit -> remote apply.
 *
 * One prober per document inserts a marker carrying the moment it was created;
 * every other client on that document records `Date.now() - ts` the instant the
 * marker arrives.
 *
 * Date.now(), NEVER performance.now(). Every worker is a thread inside one
 * process, and performance.now() is measured from a PER-THREAD time origin — a
 * delta computed across two threads would be meaningless while looking entirely
 * plausible. Date.now() shares one epoch across every thread. (This holds only
 * because the harness is one process on one machine; a multi-machine harness
 * would need clock sync, and that is out of scope for all of Phase 8.)
 *
 * Markers are NEVER removed (module 8.2 decision F1). A deletion is an edit like
 * any other: it would add updates to the log, inflate the DB write rate being
 * measured, and make the final document length depend on observation timing.
 * They stay in the text as permanent measurement data, and their characters are
 * accounted for in the convergence check.
 */

/** «» are single characters the harness's own a–z typing never produces, so a
 *  scan cannot false-positive on ordinary load text. */
const MARKER = /«L:(\d+):(\d+):([0-9a-z]+)»/g;

export interface Marker {
  owner: number;
  key: string;
  ts: number;
}

/** ~20 characters. Base36 for the timestamp: 8 characters instead of 13. */
export function makeMarker(clientIndex: number, seq: number, now: number): string {
  return `«L:${clientIndex}:${seq}:${now.toString(36)}»`;
}

/**
 * Scans INSERTED text only, never the whole document.
 *
 * Scanning the full text on every change would be O(document) per keystroke,
 * which at a few hundred clients would make the instrument the load. A marker is
 * written in one insert() call, so it arrives as one insert delta.
 *
 * A marker split across two deltas by a concurrent edit at the same offset is
 * simply not seen. That costs one sample out of thousands; it cannot corrupt the
 * ones that are recorded.
 */
export function scanMarkers(inserted: string): Marker[] {
  const found: Marker[] = [];
  MARKER.lastIndex = 0;

  for (const match of inserted.matchAll(MARKER)) {
    const [, owner, seq, ts] = match;
    if (owner === undefined || seq === undefined || ts === undefined) continue;

    found.push({
      owner: Number(owner),
      key: `${owner}:${seq}`,
      ts: parseInt(ts, 36),
    });
  }
  return found;
}

/** One observation: when the marker was created, and how long it took to arrive. */
export interface Sample {
  /** Marker creation time (epoch ms) — what warm-up filtering is applied to. */
  t: number;
  /** Latency in ms. */
  l: number;
}

export interface LatencyStats {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  n: number;
  discarded: number;
  unit: 'ms';
}

/** Nearest-rank, no interpolation: defensible in one sentence, which matters
 *  more here than sophistication. */
function nearestRank(sorted: number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? null;
}

/**
 * Warm-up exclusion happens here, on the marker's OWN embedded timestamp — so it
 * is exact rather than an approximation of when the window opened.
 *
 * n === 0 yields null percentiles, never 0. Zero is a measurement; null is the
 * absence of one, and they must never look alike in a results table.
 */
export function summarise(samples: Sample[], measureFrom: number): LatencyStats {
  const kept: number[] = [];
  let discarded = 0;

  for (const sample of samples) {
    if (sample.t < measureFrom) discarded += 1;
    else kept.push(sample.l);
  }

  kept.sort((a, b) => a - b);
  const n = kept.length;

  return {
    p50: nearestRank(kept, 50),
    p95: nearestRank(kept, 95),
    p99: nearestRank(kept, 99),
    min: n === 0 ? null : (kept[0] ?? null),
    max: n === 0 ? null : (kept[n - 1] ?? null),
    mean: n === 0 ? null : Math.round((kept.reduce((a, b) => a + b, 0) / n) * 100) / 100,
    n,
    discarded,
    unit: 'ms',
  };
}

/**
 * Proves the arithmetic against known data. Runs with `--self-check`.
 *
 * node:assert rather than a test framework: three assertions do not justify
 * adding vitest to this workspace, and a load harness that needs a test runner
 * to start is a load harness nobody runs.
 */
export function selfCheck(): void {
  const hundred: Sample[] = Array.from({ length: 100 }, (_, i) => ({ t: 0, l: i + 1 }));
  const stats = summarise(hundred, 0);

  assert.equal(stats.p50, 50, 'p50 of 1..100');
  assert.equal(stats.p95, 95, 'p95 of 1..100');
  assert.equal(stats.p99, 99, 'p99 of 1..100');
  assert.equal(stats.min, 1);
  assert.equal(stats.max, 100);
  assert.equal(stats.n, 100);

  const empty = summarise([], 0);
  assert.equal(empty.p50, null, 'no samples must give null, never 0');
  assert.equal(empty.n, 0);

  const warm = summarise(
    [
      { t: 100, l: 999 },
      { t: 200, l: 5 },
    ],
    150,
  );
  assert.equal(warm.n, 1, 'warm-up filter keeps only samples at/after the cutoff');
  assert.equal(warm.discarded, 1);
  assert.equal(warm.p50, 5);

  const marker = makeMarker(3, 7, 1755240000000);
  const scanned = scanMarkers(`abc${marker}def`);
  assert.equal(scanned.length, 1, 'a marker is found inside surrounding text');
  assert.equal(scanned[0]?.owner, 3);
  assert.equal(scanned[0]?.ts, 1755240000000, 'base36 timestamp round-trips');
  assert.equal(scanMarkers('just ordinary abcdef typing').length, 0);

  console.log('self-check: percentiles, warm-up filter and marker round-trip all OK');
}
