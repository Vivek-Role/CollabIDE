import { randomUUID } from 'node:crypto';

import { MAX_RUN_FILES, MAX_RUN_INPUT_BYTES, languageForPath } from '@collab/shared';
import type { RunFile, RunJob } from '@collab/shared';

import { AppError } from '../../http/errors.js';
import { flushAllRooms } from '../collab/index.js';
import { listFilesForRun } from '../files/index.js';
import { getQueue } from './queue.js';
import * as registry from './registry.js';

/**
 * Starting a run: authorize (the route), validate, flush, collect, cap, enqueue.
 *
 * The order matters and is not arbitrary — see startRun below.
 */

/** Bounds the job payload, which sits in Redis until the runner takes it. */
function assertWithinCaps(files: readonly RunFile[]): void {
  if (files.length > MAX_RUN_FILES) {
    throw new AppError(
      413,
      'RUN_TOO_LARGE',
      `This project has ${files.length} files; a run allows at most ${MAX_RUN_FILES}.`,
    );
  }

  // Bytes, not characters: 'é' is one character and two bytes on the wire.
  let total = 0;
  for (const file of files) total += Buffer.byteLength(file.content, 'utf8');

  if (total > MAX_RUN_INPUT_BYTES) {
    throw new AppError(
      413,
      'RUN_TOO_LARGE',
      `This project is ${total} bytes; a run allows at most ${MAX_RUN_INPUT_BYTES}.`,
    );
  }
}

export async function startRun(
  projectId: string,
  userId: string,
  entrypoint: string,
): Promise<{ jobId: string }> {
  // The language is resolved from the extension, never sent by the client.
  const languageId = languageForPath(entrypoint);
  if (!languageId) {
    throw new AppError(
      400,
      'LANGUAGE_UNSUPPORTED',
      'There is no runtime for this file type.',
    );
  }

  // File.content is derived state that lags the update log by up to one flush
  // interval (~2s). Running the version from two seconds ago is the most
  // confusing bug this feature could ship, so force a flush before reading.
  await flushAllRooms();

  const files = await listFilesForRun(projectId);

  const target = files.find((file) => file.path === entrypoint);
  if (!target) {
    throw new AppError(404, 'FILE_NOT_FOUND', 'File not found');
  }

  assertWithinCaps(files);

  const jobId = randomUUID();
  const job: RunJob = { jobId, projectId, languageId, entrypoint, files };

  // Subscribe BEFORE enqueueing. Pub/Sub is at-most-once, and a fast program
  // can finish before a later subscription exists. `open` also enforces the
  // active-run cap, so it must run before anything is queued.
  await registry.open(jobId, projectId, userId);

  try {
    await getQueue().add('run', job, {
      // No retries. Re-running code that failed is the user's decision, made by
      // pressing Run again — there is no second retry path anywhere.
      attempts: 1,
      // Each payload carries a whole project; nothing reads finished job state,
      // because the frames are the only execution-result channel.
      removeOnComplete: true,
      removeOnFail: true,
    });
  } catch (error) {
    // A failed enqueue must not leak the subscription or its slot.
    await registry.close(jobId);
    throw error;
  }

  return { jobId };
}
