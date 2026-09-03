import { RUN_QUEUE_NAME, RunStatus, runChannel } from '@collab/shared';
import type { RunFrame, RunJob } from '@collab/shared';
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { runWithLimits } from './sandbox/index.js';

/**
 * The BullMQ worker: one job in, a stream of frames out.
 *
 * The handler is deliberately thin. Module 6.4 already decided what a timeout
 * is, what truncation is, and what a sandbox failure is — LimitedRunResult maps
 * field-for-field onto the `exit` frame, so this file translates and never
 * interprets.
 *
 * The runner imports no Prisma and no Yjs: it receives plain text in the job
 * payload and has no idea what a document is. It serves no HTTP or WebSocket
 * traffic either. Its only contact with apps/server is this queue and the Redis
 * channel below, with types from @collab/shared.
 */

/** Two containers at most: each is capped at 256m and 0.5 CPU, and 2x that is
 *  what this machine absorbs unnoticed. It is also Phase 6's only backpressure. */
const CONCURRENCY = 2;

export function startWorker(connection: Redis, publisher: Redis): Worker<RunJob> {
  const worker = new Worker<RunJob>(
    RUN_QUEUE_NAME,
    (job) => handleRunJob(job, publisher),
    { connection, concurrency: CONCURRENCY },
  );

  worker.on('ready', () => console.log(`[runner] worker ready on "${RUN_QUEUE_NAME}"`));
  worker.on('error', (error) => console.error('[runner] worker error:', error));

  return worker;
}

/**
 * Runs one job and publishes its output.
 *
 * NEVER throws for an execution result, including RunStatus.Error. The terminal
 * frame is the single execution-result channel: a client learns what happened
 * from the frame and from nowhere else. Throwing would mark the BullMQ job
 * failed, which nothing reads — there is no dead-letter queue, no job-state
 * subscriber, and with attempts=1 no retry — so it would be a failure signal
 * with no receiver. Every job therefore completes from BullMQ's point of view,
 * including runs that failed.
 *
 * `attempts: 1` is set by the producer when the job is added (module 6.6).
 * There is no retry here and no second failure path anywhere.
 */
async function handleRunJob(job: Job<RunJob>, publisher: Redis): Promise<void> {
  const { jobId, projectId, languageId, entrypoint, files } = job.data;
  const channel = runChannel(jobId);

  let terminalSent = false;

  const publish = async (frame: RunFrame): Promise<void> => {
    try {
      await publisher.publish(channel, JSON.stringify(frame));
    } catch (error) {
      // Redis being unreachable cannot be fixed by throwing inside a handler.
      console.error(`[runner] publish failed on ${channel}:`, error);
    }
  };

  /** Three call sites, exactly one frame. */
  const sendExit = async (frame: RunFrame): Promise<void> => {
    if (terminalSent) return;
    terminalSent = true;
    await publish(frame);
  };

  const failed = (message: string): RunFrame => ({
    type: 'exit',
    status: RunStatus.Error,
    exitCode: null,
    durationMs: 0,
    truncated: false,
    message,
  });

  console.log(`[runner] run ${jobId} (project ${projectId}, ${languageId}) started`);

  try {
    const result = await runWithLimits({
      // The container is named and labelled with the job id, so a container in
      // `docker ps` traces straight back to a job.
      runId: jobId,
      languageId,
      entrypoint,
      files,
      // Fire-and-forget, but still ordered: ioredis queues commands on one
      // connection in the order they were issued, and these are issued
      // synchronously as output arrives.
      onOutput: (stream, data) => void publish({ type: stream, data }),
    });

    await sendExit({
      type: 'exit',
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      truncated: result.truncated,
      message: result.message,
    });

    console.log(
      `[runner] run ${jobId} ${result.status} exit=${result.exitCode} in ${result.durationMs}ms` +
        (result.truncated ? ' (truncated)' : ''),
    );
  } catch (error) {
    // Should be unreachable: runWithLimits returns status 'error' rather than
    // throwing. Kept because "should be unreachable" is not a guarantee, and
    // the cost of being wrong is a browser tab that spins forever.
    console.error(`[runner] run ${jobId} threw:`, error);
    await sendExit(failed('run failed'));
  } finally {
    // Last resort. If the two paths above somehow both missed, the client still
    // learns the run is over.
    await sendExit(failed('run failed'));
  }
}
