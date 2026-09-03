import { MAX_OUTPUT_BYTES, runChannel } from '@collab/shared';
import type { RunFrame } from '@collab/shared';
import { Redis } from 'ioredis';

import { config } from '../../config.js';
import { AppError } from '../../http/errors.js';

/**
 * One subscription per in-flight run, opened BEFORE the job is enqueued.
 *
 * Why this exists at all: Redis Pub/Sub is at-most-once. If the server only
 * subscribed when the browser's SSE request arrived, everything published
 * before that moment would be gone — and a small program finishes in roughly
 * 300ms, the same order as the POST/SSE round trip. `print("hi")` would
 * routinely lose its entire output AND its terminal frame, leaving a terminal
 * that streams nothing forever. So the subscription is established first, and
 * anything that arrives before a client attaches is buffered.
 *
 * The registry is in memory, which makes this single-instance — the same shape
 * as the collab room registry. Phase 7 owns run routing across instances; this
 * module's job is not to pre-build for it.
 */

/** A run belongs to a project, and a jobId is never a capability on its own. */
export interface RunEntry {
  readonly jobId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly subscriber: Redis;
  /** Frames received before a client attached, replayed in order on attach. */
  buffered: RunFrame[];
  bufferedBytes: number;
  /** The attached SSE response, if any. */
  sink: ((frame: RunFrame) => void) | null;
  terminal: boolean;
  timer: NodeJS.Timeout;
}

/**
 * Bounds the number of live subscriber connections, since there is one per run
 * (a shared subscriber would need a fan-out map and unsubscribe accounting for
 * no benefit at this scale). Worker concurrency 2 bounds execution, not
 * enqueueing: a client that POSTs repeatedly without ever opening a stream
 * would otherwise accumulate connections until the TTL.
 *
 * Counts ACTIVE entries only. A finished run frees its slot the moment its
 * terminal frame arrives, so this is never a quota on how many runs a project
 * may perform.
 */
const MAX_ACTIVE_RUNS = 20;

/** An entry nobody attached to, or whose terminal frame never arrived. A run
 *  cannot exceed 10s, so this is a backstop rather than a normal path. */
const ENTRY_TTL_MS = 120_000;

const entries = new Map<string, RunEntry>();

/**
 * Subscribes to this run's channel and registers it.
 *
 * MUST be awaited before the job is enqueued: the SUBSCRIBE has to be
 * acknowledged by Redis before anything can be published, or the race above is
 * still open.
 */
export async function open(
  jobId: string,
  projectId: string,
  userId: string,
): Promise<RunEntry> {
  if (entries.size >= MAX_ACTIVE_RUNS) {
    throw new AppError(
      429,
      'TOO_MANY_RUNS',
      `Too many runs are in progress (${MAX_ACTIVE_RUNS}). Wait for one to finish.`,
    );
  }

  const subscriber = new Redis(config.redisUrl);

  const entry: RunEntry = {
    jobId,
    projectId,
    userId,
    subscriber,
    buffered: [],
    bufferedBytes: 0,
    sink: null,
    terminal: false,
    timer: setTimeout(() => void close(jobId), ENTRY_TTL_MS),
  };

  subscriber.on('message', (_channel, payload) => receive(entry, payload));
  await subscriber.subscribe(runChannel(jobId));

  entries.set(jobId, entry);
  return entry;
}

function receive(entry: RunEntry, payload: string): void {
  let frame: RunFrame;
  try {
    frame = JSON.parse(payload) as RunFrame;
  } catch {
    console.error(`[execution] unparseable frame on run ${entry.jobId}`);
    return;
  }

  if (entry.sink) {
    entry.sink(frame);
  } else if (entry.bufferedBytes < MAX_OUTPUT_BYTES) {
    // The run itself is already truncated at this limit, so this only bounds
    // the pre-attach window.
    entry.buffered.push(frame);
    entry.bufferedBytes += payload.length;
  }

  if (frame.type === 'exit') {
    // Nothing more will be published, so the subscriber connection can go.
    entry.terminal = true;
    void releaseSubscriber(entry);

    // The ENTRY, though, must outlive the run when nobody has attached yet.
    // A fast program finishes in ~300ms — before the browser opens its stream —
    // and deleting here would throw away the buffered output and the exit frame
    // that the client is about to ask for, turning the common case into a 404.
    // It is dropped once a client has drained it (see attach), or by the TTL.
    if (entry.sink) remove(entry.jobId);
  }
}

/**
 * Attaches an SSE sink, replaying anything buffered first, in order.
 *
 * Returns false when the run has no entry — unknown, expired, or already
 * finished — which the route turns into a 404.
 */
export function attach(jobId: string, sink: (frame: RunFrame) => void): boolean {
  const entry = entries.get(jobId);
  if (!entry) return false;

  entry.sink = sink;

  const replay = entry.buffered;
  entry.buffered = [];
  entry.bufferedBytes = 0;
  for (const frame of replay) sink(frame);

  // The run had already finished before this client arrived. It has now been
  // handed everything, including the exit frame, so the entry can go.
  if (entry.terminal) remove(jobId);

  return true;
}

/**
 * Detaches a disconnected client. The subscription deliberately stays open so
 * the run can still reach its terminal frame — a second watcher, or a client
 * that comes back, still gets the ending. The entry is then removed by the
 * terminal frame or the TTL.
 */
export function detach(jobId: string): void {
  const entry = entries.get(jobId);
  if (entry) entry.sink = null;
}

/**
 * Teardown, in two halves, because they happen at different moments.
 *
 * The subscriber goes as soon as the terminal frame arrives — nothing more will
 * be published. The entry survives until a client has drained it, so a run that
 * finished before anyone attached can still be read.
 */
async function releaseSubscriber(entry: RunEntry): Promise<void> {
  if (entry.subscriber.status === 'end') return;

  try {
    await entry.subscriber.quit();
  } catch (error) {
    console.error(`[execution] failed to close subscriber for ${entry.jobId}:`, error);
  }
}

function remove(jobId: string): void {
  const entry = entries.get(jobId);
  if (!entry) return;

  entries.delete(jobId);
  clearTimeout(entry.timer);
  entry.sink = null;
}

/** Both halves. Used by the TTL, a failed enqueue, and shutdown. */
export async function close(jobId: string): Promise<void> {
  const entry = entries.get(jobId);
  if (!entry) return;

  remove(jobId);
  await releaseSubscriber(entry);
}

/** Used by the SSE route: a job started in another project is not yours. */
export function get(jobId: string): RunEntry | undefined {
  return entries.get(jobId);
}

/** Shutdown, and the test harness. */
export async function closeAll(): Promise<void> {
  await Promise.all([...entries.keys()].map((jobId) => close(jobId)));
}

export function activeCount(): number {
  return entries.size;
}
