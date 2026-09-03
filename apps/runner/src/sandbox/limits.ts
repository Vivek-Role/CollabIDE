/**
 * The run policy: how long a program may run, and how much it may say.
 *
 * This wraps runInContainer rather than modifying it. docker.ts stays "how to
 * run a container" and reports facts; this file is "what our limits are" and
 * interprets them into a RunStatus. Module 6.5's worker calls runWithLimits,
 * never runInContainer directly.
 *
 * Two limits, one kill path:
 *   - a 10 second wall clock (RUN_TIMEOUT_MS)
 *   - ~1 MB of output (MAX_OUTPUT_BYTES), after which the container is killed
 *
 * Both abort the same AbortController, which is why the reason is recorded
 * FIRST-WRITER-WINS: a program that floods output *and* runs long trips the cap
 * at ~9.9s and the timer would otherwise fire 100ms later and overwrite the
 * reason, reporting a truncated run as a timeout. The AbortController fires
 * only once, so nothing else catches that — only the guard in abortWith does.
 */

import { MAX_OUTPUT_BYTES, RUN_TIMEOUT_MS, RunStatus } from '@collab/shared';

import { runInContainer } from './docker.js';
import type { RunSpec } from './docker.js';

/** Everything the caller supplies; the signal is this module's to own. */
export type LimitedRunSpec = Omit<RunSpec, 'signal'>;

export interface LimitedRunResult {
  readonly status: RunStatus;
  /** The program's own exit code, or null when it was killed. */
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** True when the output cap cut the run short. */
  readonly truncated: boolean;
  /** Only for status 'error'. Never carries user code or a stack trace. */
  readonly message?: string;
}

/** Why we asked the container to stop. null means we never did. */
type AbortReason = 'timeout' | 'output' | null;

export async function runWithLimits(spec: LimitedRunSpec): Promise<LimitedRunResult> {
  const controller = new AbortController();
  const startedAt = Date.now();

  let reason: AbortReason = null;
  let sentBytes = 0;

  /** First writer wins. Later limiters must not overwrite the outcome. */
  const abortWith = (why: Exclude<AbortReason, null>): void => {
    if (reason !== null) return;
    reason = why;
    controller.abort();
  };

  /**
   * Counts bytes, not characters: 'é' is one character and two bytes, and what
   * is being protected is the Redis publish in 6.5 and the browser in 6.7.
   *
   * The chunk that crosses the cap is cut at the byte budget, so its final
   * character may be a partial sequence — it decodes to U+FFFD. That is the
   * last character of an already-truncated stream, and paying for a decoder to
   * avoid it would buy nothing.
   */
  const onOutput: RunSpec['onOutput'] = (stream, chunk) => {
    if (reason === 'output') return;

    const size = Buffer.byteLength(chunk, 'utf8');

    if (sentBytes + size <= MAX_OUTPUT_BYTES) {
      sentBytes += size;
      spec.onOutput(stream, chunk);
      return;
    }

    const remaining = MAX_OUTPUT_BYTES - sentBytes;
    if (remaining > 0) {
      sentBytes += remaining;
      spec.onOutput(stream, Buffer.from(chunk, 'utf8').subarray(0, remaining).toString('utf8'));
    }

    // Kill rather than merely stop forwarding: a program printing in a loop
    // would otherwise burn CPU for the rest of its 10 seconds with nobody
    // listening. Killing is what makes this a cap rather than a filter.
    abortWith('output');
  };

  const timer = setTimeout(() => abortWith('timeout'), RUN_TIMEOUT_MS);

  try {
    const result = await runInContainer({ ...spec, onOutput, signal: controller.signal });

    if (reason === 'timeout') {
      return {
        status: RunStatus.Timeout,
        exitCode: null,
        durationMs: result.durationMs,
        truncated: false,
      };
    }

    // A run killed for being loud still ran: it produced output and we stopped
    // reading. That is not the same failure as running forever, so it is `ok`
    // with `truncated`, and never `timeout`.
    return {
      status: RunStatus.Ok,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      truncated: reason === 'output',
    };
  } catch (error) {
    // The sandbox could not carry the run out — a missing image, a daemon that
    // is down, bad input. Distinct from the program itself failing.
    return {
      status: RunStatus.Error,
      exitCode: null,
      durationMs: Date.now() - startedAt,
      truncated: reason === 'output',
      message: error instanceof Error ? error.message : 'run failed',
    };
  } finally {
    // A timer left armed would abort a controller nobody is listening to, and
    // in a long-lived worker that is a slow leak.
    clearTimeout(timer);
  }
}
