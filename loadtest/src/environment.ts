import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Captured automatically at the start of every run and embedded in the result
 * blob, so it can never be forgotten or misremembered.
 *
 * The WSL2 cap is load-bearing: every number this project produces is bounded by
 * 6 GB / 4 processors, and a number quoted without that is misleading. It has to
 * survive into module 8.3's results file.
 *
 * Nothing here shells out to `docker` (decision F3): the CLI is not available
 * inside this WSL distro at all. Image tags are read out of the compose file as
 * text, and the engine version is an operator-supplied field in 8.3.
 */

export interface Environment {
  date: string;
  timezone: string;
  gitSha: string | null;
  gitBranch: string | null;
  gitDirty: boolean | null;
  node: string;
  cpuModel: string | null;
  cpuCount: number;
  totalMemMb: number;
  kernel: string;
  platform: string;
  wslConfig: string | null;
  wslConfigReason?: string;
  images: string[];
  docker: string;
  topology: string;
  argv: string;
}

async function git(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Windows home is not derivable from $HOME inside WSL, so a few known paths are
 *  tried and WSLCONFIG_PATH overrides. Never guessed at: if it cannot be read,
 *  the blob says so. */
async function readWslConfig(): Promise<{ text: string | null; reason?: string }> {
  const candidates = [
    process.env['WSLCONFIG_PATH'],
    `/mnt/c/Users/${process.env['USER'] ?? ''}/.wslconfig`,
    '/mnt/c/Users/vivek/.wslconfig',
  ].filter((path): path is string => path !== undefined && path.length > 0);

  for (const path of candidates) {
    try {
      return { text: (await readFile(path, 'utf8')).trim() };
    } catch {
      continue;
    }
  }
  return { text: null, reason: 'no readable .wslconfig; set WSLCONFIG_PATH' };
}

async function readImages(): Promise<string[]> {
  try {
    const compose = await readFile('infra/docker-compose.yml', 'utf8');
    return [...compose.matchAll(/^\s*image:\s*(\S+)/gm)].map((match) => match[1] ?? '');
  } catch {
    return [];
  }
}

export async function captureEnvironment(topology: string, argv: string): Promise<Environment> {
  const [sha, branch, porcelain, wsl, images] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--porcelain']),
    readWslConfig(),
    readImages(),
  ]);

  const cpus = os.cpus();

  return {
    date: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    gitSha: sha,
    gitBranch: branch,
    gitDirty: porcelain === null ? null : porcelain.length > 0,
    node: process.version,
    cpuModel: cpus[0]?.model ?? null,
    cpuCount: cpus.length,
    totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
    kernel: os.release(),
    platform: `${os.type()} ${os.arch()}`,
    wslConfig: wsl.text,
    ...(wsl.reason === undefined ? {} : { wslConfigReason: wsl.reason }),
    images,
    // The Docker CLI is not available in this WSL distro; recorded rather than
    // guessed. The operator supplies the real version in module 8.3.
    docker: 'unavailable from WSL — operator-supplied in 8.3',
    topology,
    argv,
  };
}
