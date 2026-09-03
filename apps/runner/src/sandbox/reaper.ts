/**
 * The reaper: removes containers this project created and then lost track of.
 *
 * runInContainer cleans up after itself on every path, so in normal operation
 * this finds nothing. What it exists for is a runner killed by SIGKILL mid-run,
 * which cannot run its finally block — without the reaper that container and
 * its volume stay forever.
 *
 * Safety rules, which matter more than the code:
 *   - filter on label=ce.run and nothing else, so it can never touch a
 *     container this project did not create (the compose containers carry no
 *     such label and are invisible to it);
 *   - only remove containers older than maxAgeMs, because a younger one may be
 *     a live run — the 10s timeout guarantees a legitimate one is long gone by
 *     the 60s default;
 *   - `docker rm -fv`, never `docker container prune`: prune leaves the
 *     anonymous /work volume behind, converting a container leak into a slower
 *     volume leak;
 *   - `docker volume prune` is FORBIDDEN. Our volumes are anonymous and carry
 *     no label, so a prune would be indiscriminate and would happily delete an
 *     unrelated volume belonging to the user. Volumes are removed only by
 *     rm -v on the container that owns them.
 *
 * Module 6.5 starts the interval; this module only exports the sweep.
 */

import { spawn } from 'node:child_process';

const RUN_LABEL = 'ce.run';
const DEFAULT_MAX_AGE_MS = 60_000;

/**
 * A local runner for the docker CLI, kept separate from docker.ts's: this one
 * resolves with the exit code instead of throwing, because every failure here
 * is swallowed anyway. An argv array, never a shell string.
 */
function docker(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

    child.on('error', (error) => resolve({ code: null, stdout: '', stderr: error.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * `docker inspect -f '{{.ID}} {{.Created}}'` gives strict RFC3339
 * (2026-08-14T14:04:34.619877107Z), which Date parses to the correct instant by
 * specification.
 *
 * `docker ps --format '{{.CreatedAt}}'` would have saved a process spawn, but
 * it emits `2026-08-14 14:04:02 +0000 UTC` — not ISO 8601. V8 happens to parse
 * that today, but a reaper that silently mis-parses a date either deletes live
 * containers or never deletes anything, and neither is worth one spawn.
 */
function parseInspectLine(line: string): { id: string; createdMs: number } | null {
  const [id, created] = line.trim().split(/\s+/);
  if (!id || !created) return null;

  const createdMs = new Date(created).getTime();
  if (Number.isNaN(createdMs)) return null;

  return { id, createdMs };
}

/**
 * Removes ce.run-labelled containers older than maxAgeMs, and their volumes
 * with them. Returns how many were removed.
 *
 * Never throws: it runs on an interval in a long-lived worker, where an
 * unhandled rejection would take the process down. Failures are logged.
 */
export async function reapStaleContainers(maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<number> {
  const listed = await docker(['ps', '-aq', '--filter', `label=${RUN_LABEL}`]);
  if (listed.code !== 0) {
    console.error('[reaper] could not list containers:', listed.stderr.trim());
    return 0;
  }

  const ids = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (ids.length === 0) return 0;

  const inspected = await docker(['inspect', '-f', '{{.ID}} {{.Created}}', ...ids]);
  if (inspected.code !== 0) {
    console.error('[reaper] could not inspect containers:', inspected.stderr.trim());
    return 0;
  }

  const cutoff = Date.now() - maxAgeMs;
  const stale = inspected.stdout
    .split('\n')
    .map(parseInspectLine)
    .filter((entry) => entry !== null)
    .filter((entry) => entry.createdMs <= cutoff)
    .map((entry) => entry.id);

  if (stale.length === 0) return 0;

  const removed = await docker(['rm', '-fv', ...stale]);
  if (removed.code !== 0) {
    console.error('[reaper] could not remove containers:', removed.stderr.trim());
    return 0;
  }

  console.log(`[reaper] removed ${stale.length} stale container(s)`);
  return stale.length;
}
