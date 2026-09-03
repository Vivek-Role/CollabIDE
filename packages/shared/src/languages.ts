/**
 * The execution contract, and the only place it is written down.
 *
 * Everything apps/server and apps/runner must agree on to run code: which
 * languages exist, what a job on the queue looks like, what its output looks
 * like on the wire, and the limits both sides enforce.
 *
 * Deliberately dependency-free, like protocol.ts beside it — this file imports
 * nothing at all. That is what lets apps/runner consume it without pulling in
 * Prisma or a CRDT it will never use, and it is a property worth protecting:
 * a validation library here would become a runtime dependency of the runner for
 * no gain, since languageById below is already the boundary that matters.
 *
 * The promise this file makes: **adding a language is a config-only change.**
 * One entry in LANGUAGES plus one Dockerfile, and nothing else anywhere. There
 * is deliberately no switch and no `id === 'python'` in this module; every
 * difference between languages lives in its registry entry. If that ever stops
 * being true, this file has regressed.
 */

// ── the registry ────────────────────────────────────────────────────────────

export interface LanguageConfig {
  /** For the Run button and error messages. */
  readonly label: string;
  /** Pinned image tag, built by module 6.2. Never `:latest`. */
  readonly image: string;
  /**
   * argv prefix, never a shell string. The runner (6.5) appends the
   * entrypoint's real project-relative path, so a filename out of the database
   * can never become shell syntax.
   */
  readonly cmd: readonly string[];
  /**
   * Compiled languages only. Nothing sets it in Phase 6 — the field exists so
   * that adding a compiled language stays a config-only change.
   */
  readonly compile?: readonly string[];
  /** Lowercase, no leading dot. Every extension that runs as this language. */
  readonly extensions: readonly string[];
}

/**
 * The single source of truth. **The key IS the language id** — there is no
 * separate id list and no `id` field, so adding a language is exactly one entry.
 *
 * `satisfies` type-checks each entry against LanguageConfig while `as const`
 * keeps the keys literal, which is what lets LanguageId derive from them.
 *
 * No TypeScript entry, deliberately: the editor highlights .ts and .tsx, but a
 * slim Node image cannot execute them. Opening a file and running it are
 * different questions, and languageForPath answers the second one with null.
 */
export const LANGUAGES = {
  python: {
    label: 'Python',
    image: 'collab-sandbox-python:1',
    // -u is not cosmetic: Python buffers stdout to a pipe, so without it a
    // program that prints for eight seconds delivers everything at exit and
    // the streaming terminal streams nothing. Node line-buffers already.
    cmd: ['python', '-u'],
    extensions: ['py'],
  },
  javascript: {
    label: 'JavaScript',
    image: 'collab-sandbox-node:1',
    cmd: ['node'],
    extensions: ['js', 'mjs', 'cjs'],
  },
} as const satisfies Record<string, LanguageConfig>;

/** Derived, never hand-written: a new registry entry widens this for free. */
export type LanguageId = keyof typeof LANGUAGES;

// ── queue and channel names ─────────────────────────────────────────────────

/** The BullMQ queue. The server adds to it (6.6); the runner consumes it (6.5). */
export const RUN_QUEUE_NAME = 'exec';

/**
 * The Redis Pub/Sub channel carrying one run's output frames.
 *
 * A function rather than a documented convention so `run:` is written once.
 * Two processes agreeing on a channel name by both typing it correctly works
 * right up until it does not.
 */
export function runChannel(jobId: string): string {
  return `run:${jobId}`;
}

// ── limits ──────────────────────────────────────────────────────────────────

/** Wall clock, enforced by module 6.4: exceeded means the container is killed. */
export const RUN_TIMEOUT_MS = 10_000;

/** Total output bytes before 6.4 truncates and kills. */
export const MAX_OUTPUT_BYTES = 1_000_000;

/** Per-run input caps, enforced by module 6.6 before anything is enqueued. */
export const MAX_RUN_FILES = 100;
export const MAX_RUN_INPUT_BYTES = 1_000_000;

// ── job payload ─────────────────────────────────────────────────────────────

/** One file as the runner receives it: plain text, never a CRDT. */
export interface RunFile {
  /** Project-relative, e.g. `src/main.py`. Validated by files/paths.ts already. */
  readonly path: string;
  readonly content: string;
}

/**
 * The BullMQ job body. The server writes it, the runner reads it, and it must
 * stay JSON-serializable — no Date, no Map, no class instance.
 */
export interface RunJob {
  readonly jobId: string;
  /** The runner queries nothing with this: it is for worker logs and for
   *  reading a stuck queue. */
  readonly projectId: string;
  readonly languageId: LanguageId;
  /**
   * Which file to run, project-relative, and one of `files`. It executes at
   * this same path inside the container so relative imports resolve — which is
   * why no per-language entrypoint filename exists.
   */
  readonly entrypoint: string;
  readonly files: readonly RunFile[];
}

// ── output frames ───────────────────────────────────────────────────────────

export const RunStatus = {
  /** The program ran to completion. Its own exit code may still be non-zero. */
  Ok: 'ok',
  /** RUN_TIMEOUT_MS was reached and the container was killed. */
  Timeout: 'timeout',
  /** The run could not be carried out — a sandbox or worker failure. */
  Error: 'error',
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/**
 * One message on `run:<jobId>`, a discriminated union on `type`.
 *
 * **Exactly one 'exit' frame ends every run, on every path**, including a
 * thrown worker error — it is the only way the browser learns a run finished,
 * and a run without one is a spinner that never stops. Module 6.5 publishes it
 * from a finally block.
 *
 * `status` and `exitCode` are separate on purpose: a program that legitimately
 * exits 1 is `ok` with `exitCode: 1`. That is not a failure of the run.
 */
export type RunFrame =
  | { readonly type: 'stdout'; readonly data: string }
  | { readonly type: 'stderr'; readonly data: string }
  | {
      readonly type: 'exit';
      readonly status: RunStatus;
      /** null when the container was killed rather than exiting on its own. */
      readonly exitCode: number | null;
      readonly durationMs: number;
      /** True when MAX_OUTPUT_BYTES cut the run short. */
      readonly truncated: boolean;
      /** Only for status 'error'. Never carries user code or a stack trace. */
      readonly message?: string;
    };

// ── resolvers ───────────────────────────────────────────────────────────────

/**
 * Built from LANGUAGES itself at module load, never a second hand-written
 * table — a duplicate map is exactly how "config-only" quietly stops being true.
 */
const EXTENSION_TO_ID = new Map<string, LanguageId>();

for (const [id, config] of Object.entries(LANGUAGES) as [
  LanguageId,
  LanguageConfig,
][]) {
  for (const extension of config.extensions) {
    EXTENSION_TO_ID.set(extension, id);
  }
}

/**
 * The lowercase extension without its dot, or null when there is none.
 *
 * `dot <= 0` treats `.gitignore` as a dotfile rather than an extension of
 * "gitignore" — the same rule apps/web's editor language map follows.
 */
export function extensionOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');

  if (dot <= 0 || dot === base.length - 1) return null;

  return base.slice(dot + 1).toLowerCase();
}

/**
 * The id of the language that runs this file, or null if nothing does.
 *
 * Returns a value rather than throwing, like parseDocId in protocol.ts: the
 * caller's job is to choose an error response, which a null makes a two-line
 * branch. A file with no runtime is a normal thing, not an exception.
 */
export function languageForPath(path: string): LanguageId | null {
  const extension = extensionOf(path);
  if (extension === null) return null;

  return EXTENSION_TO_ID.get(extension) ?? null;
}

/**
 * Narrows an untrusted string to a registry key. Takes `string`, not
 * LanguageId, because the caller is holding a value off a queue that TypeScript
 * cannot vouch for — this is where it becomes trustworthy.
 */
export function isLanguageId(value: string): value is LanguageId {
  return Object.hasOwn(LANGUAGES, value);
}

/** The config for an id off the wire, or null if it names no language. */
export function languageById(id: string): LanguageConfig | null {
  return isLanguageId(id) ? LANGUAGES[id] : null;
}
