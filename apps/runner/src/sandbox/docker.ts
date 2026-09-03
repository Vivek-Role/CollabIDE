/**
 * The Docker driver — the only file in this repository that speaks to Docker.
 *
 * One function, runInContainer, turns a set of files and a language into a
 * finished process result: create a locked-down container from the image the
 * language registry names, copy the project in, start it, stream stdout and
 * stderr as they arrive, wait for the exit, and clean up on every path.
 *
 * apps/runner is the sole owner of the Docker socket (ADR-004). apps/server
 * never imports this file and never runs a container.
 *
 * The CLI is driven through child_process rather than a Docker SDK (ADR-005):
 * the flags below are already CLI flags, the CLI is what is installed and
 * verified, and streaming `docker start -a` is exactly a child process's
 * stdout. Every invocation is an argv array — never a shell string — because
 * file names come from a database and a shell would make that an injection
 * surface. There is no `shell: true` in this file.
 *
 * This is a reasonable local sandbox, NOT production-grade isolation: the
 * kernel is shared with the host, only Docker's default seccomp profile
 * applies, and there is no user-namespace remapping or gVisor.
 *
 * KNOWN LIMITATION: /work is a volume and therefore writable. Module 6.4 added
 * `--ulimit fsize`, which bounds ANY SINGLE FILE to 32 MiB — measured: a 200 MB
 * write stops at exactly 32 MB with EFBIG. It does NOT bound the total size of
 * the workspace, because a program can write many files. What bounds the total
 * is the 10 second timeout: writes stop when the container is killed. So
 * workspace growth is bounded in practice by disk throughput x 10s, not by a
 * quota. /work must never be described as size-limited. A hard total cap needs
 * an XFS project quota or a loopback filesystem, which is out of scope.
 *
 * Not in this module (module 6.4 owns all of it): the 10s timeout, the output
 * cap and truncation, and the reaper that sweeps leftovers from other runs.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { languageById } from '@collab/shared';
import type { LanguageId, RunFile } from '@collab/shared';

/** Which stream a chunk of output came from. */
export type OutputStream = 'stdout' | 'stderr';

export interface RunSpec {
  /** Unique per run. Becomes the container name and the ce.run label. */
  readonly runId: string;
  /** Key into LANGUAGES. Chooses the image and the argv prefix. */
  readonly languageId: LanguageId;
  /** Project-relative path of the file to execute. Must be one of `files`. */
  readonly entrypoint: string;
  /** The whole project, plain text, written verbatim into /work. */
  readonly files: readonly RunFile[];
  /** Called as output arrives — never buffered until the end. */
  readonly onOutput: (stream: OutputStream, chunk: string) => void;
  /** Module 6.4's seam: aborting kills the container. No timer lives here. */
  readonly signal?: AbortSignal;
}

export interface RunResult {
  /** The program's own exit code, or null if it was killed. */
  readonly exitCode: number | null;
  /** Wall clock around `start -a` only, so it is the program's runtime. */
  readonly durationMs: number;
  /**
   * True only when THIS driver issued the kill.
   *
   * Module 6.4 needs it: a deliberate kill and a kernel OOM both surface as
   * exit code 137, so 137 alone is ambiguous. `killed: true` means we stopped
   * it (6.4's timeout); `killed: false` with 137 means something outside our
   * code did (an OOM-style termination).
   */
  readonly killed: boolean;
}

/** Every container this driver creates carries this label key. */
const RUN_LABEL = 'ce.run';

/**
 * The sandbox. Each flag is doing a specific job:
 *
 *   --rm                     remove the container when it exits, and its
 *                            anonymous volume with it
 *   --pull never             never contact a registry; the images are built
 *                            locally by module 6.2, so a missing one means
 *                            "run infra/images/build.sh", which should fail
 *                            instantly and locally
 *   --network none           no outbound connection of any kind
 *   --memory/--memory-swap   equal values mean no swap: a large allocation is
 *                            OOM-killed rather than paged out
 *   --cpus 0.5               a busy loop cannot starve the host
 *   --pids-limit 64          fork bombs
 *   --read-only              nothing on the root filesystem is writable
 *   --tmpfs /tmp             a bounded 32m scratch, and the image's HOME
 *   --mount type=volume      /work MUST be a volume. Verified in module 6.2:
 *                            with a read-only rootfs, `docker cp` is refused
 *                            outright ("container rootfs is marked read-only")
 *                            and a tmpfs at /work is refused the same way — and
 *                            would shadow the copied files even if it were not.
 *                            An anonymous volume is writable, accepts the copy,
 *                            and inherits /work's 1000:1000 ownership from the
 *                            image.
 *   --cap-drop ALL           every Linux capability
 *   --security-opt ...       no setuid escalation
 *   --user 1000:1000         never root inside the container
 */
function createArgs(spec: RunSpec, image: string, command: readonly string[]): string[] {
  return [
    'create',
    '--rm',
    '--pull', 'never',
    '--name', containerName(spec.runId),
    '--label', `${RUN_LABEL}=${spec.runId}`,
    '--network', 'none',
    '--memory', '256m',
    '--memory-swap', '256m',
    '--cpus', '0.5',
    '--pids-limit', '64',
    '--read-only',
    '--tmpfs', '/tmp:rw,size=32m',
    '--mount', 'type=volume,dst=/work',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    // Module 6.4: bounds any single file to 32 MiB. /work is a volume and has
    // no total quota — see the limitation in the header.
    '--ulimit', 'fsize=33554432',
    '--user', '1000:1000',
    '-w', '/work',
    image,
    ...command,
    spec.entrypoint,
  ];
}

function containerName(runId: string): string {
  return `ce-run-${runId}`;
}

/**
 * Runs `docker` and resolves with its output. Rejects on a non-zero exit,
 * because every caller here treats that as a sandbox failure rather than a
 * program result — `start -a` is the one exception and does not use this.
 */
function docker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

    child.on('error', (error) => reject(new Error(`docker ${args[0]} failed: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`docker ${args[0]} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Writes the project into a host staging directory.
 *
 * One directory rather than N `docker cp` calls: `cp <dir>/. <cid>:/work`
 * delivers the whole tree in a single invocation and creates the intermediate
 * directories inside the container, which a per-file copy could not.
 *
 * Paths are validated upstream by modules/files/paths.ts, so the resolve check
 * here is defence in depth — three lines against a path that escapes /work.
 */
async function stageFiles(files: readonly RunFile[], stagingDir: string): Promise<void> {
  for (const file of files) {
    const destination = path.resolve(stagingDir, file.path);

    if (destination !== stagingDir && !destination.startsWith(stagingDir + path.sep)) {
      throw new Error(`file path escapes the workspace: ${file.path}`);
    }

    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, 'utf8');
  }
}

/**
 * Attaches to the container and streams its output until it exits.
 *
 * stdin is deliberately NOT attached (`-i` is absent), so a program calling
 * input() reads EOF instead of hanging forever on a terminal that will never
 * exist. Interactive input is out of scope for Phase 6.
 *
 * No TTY is allocated either, so Docker does not merge the two streams into one
 * pseudo-terminal: stdout and stderr arrive on separate pipes and stay
 * distinguishable. A StringDecoder per stream keeps a multi-byte character
 * split across two chunks from being corrupted.
 */
function startAndStream(
  containerId: string,
  onOutput: RunSpec['onOutput'],
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['start', '-a', containerId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    for (const stream of ['stdout', 'stderr'] as const) {
      const decoder = new StringDecoder('utf8');
      child[stream].on('data', (chunk: Buffer) => {
        const text = decoder.write(chunk);
        if (text) onOutput(stream, text);
      });
      child[stream].on('end', () => {
        const text = decoder.end();
        if (text) onOutput(stream, text);
      });
    }

    child.on('error', (error) => reject(new Error(`docker start failed: ${error.message}`)));
    child.on('close', (code) => resolve(code));
  });
}

/** Best effort: the container may already be gone, and that is a success. */
async function removeContainer(containerId: string): Promise<void> {
  try {
    await docker(['rm', '-fv', containerId]);
  } catch (error) {
    // Swallowed on purpose. `--rm` removes a container that started, so the
    // usual case here is a no-op (docker rm -f exits 0 for a missing
    // container). What this call is really for is a container left in Created
    // state by a failed `docker cp`, which --rm never reaps. A cleanup failure
    // must never mask, or roll back, a finished run.
    console.error(`[sandbox] cleanup failed for ${containerId}:`, error);
  }
}

/**
 * Runs one program in one container and resolves when it has finished.
 *
 * Resolves for anything the program itself did, including a non-zero exit — a
 * program exiting 1 ran perfectly well. Throws only when the sandbox could not
 * carry the run out: an unknown language, an entrypoint that is not in the
 * file set, a path that escapes the workspace, or Docker refusing to create,
 * copy or start.
 */
export async function runInContainer(spec: RunSpec): Promise<RunResult> {
  const language = languageById(spec.languageId);
  if (!language) {
    throw new Error(`unknown language: ${spec.languageId}`);
  }
  if (!spec.files.some((file) => file.path === spec.entrypoint)) {
    throw new Error(`entrypoint is not among the files: ${spec.entrypoint}`);
  }

  const stagingDir = await mkdtemp(path.join(tmpdir(), 'ce-run-'));
  let containerId: string | null = null;
  let killed = false;

  try {
    await stageFiles(spec.files, stagingDir);

    containerId = await docker(createArgs(spec, language.image, language.cmd));
    await docker(['cp', `${stagingDir}/.`, `${containerId}:/work`]);

    // The 6.4 seam, and the whole of it: this module can be TOLD to stop, but
    // never decides to stop. No timer, no duration, no policy.
    const id = containerId;
    const onAbort = (): void => {
      killed = true;
      void docker(['kill', id]).catch(() => {
        // Racing a container that just exited on its own is expected.
      });
    };
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    const startedAt = Date.now();
    try {
      const exitCode = await startAndStream(containerId, spec.onOutput);
      return {
        exitCode: killed ? null : exitCode,
        durationMs: Date.now() - startedAt,
        killed,
      };
    } finally {
      spec.signal?.removeEventListener('abort', onAbort);
    }
  } finally {
    if (containerId) await removeContainer(containerId);
    await rm(stagingDir, { recursive: true, force: true });
  }
}
