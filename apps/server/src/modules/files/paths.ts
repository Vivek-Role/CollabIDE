import { AppError } from '../../http/errors.js';

/**
 * Path rules for project files. Pure functions, no database, no HTTP — which is
 * why they get their own file and their own test: this is where the security
 * bugs in a file API live, and exhaustive table-driven tests are far easier
 * against a function than against a route.
 *
 * A path is POSIX, relative to the project root, with no leading slash:
 *
 *     src/main.py        ok
 *     /src/main.py       rejected (absolute)
 *     ../../etc/passwd   rejected (traversal)
 *     src//main.py       rejected (empty segment)
 *
 * **Invalid paths are rejected, never silently rewritten.** Quietly normalizing
 * `a/./b` to `a/b` would leave the client believing it created something it did
 * not, and the two would disagree about what exists from then on.
 */

export const MAX_PATH_LENGTH = 1024;
export const MAX_SEGMENT_LENGTH = 255;
export const MAX_DEPTH = 32;

/**
 * NUL through US, plus DEL. Built from escapes rather than literal characters so
 * the source stays readable and cannot be mangled by an editor. A NUL byte
 * matters most: it truncates a string in anything that later hands it to a C API.
 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]');

function invalid(reason: string): AppError {
  return new AppError(400, 'INVALID_PATH', reason);
}

export function assertValidPath(input: unknown): string {
  if (typeof input !== 'string') throw invalid('Path must be a string');
  if (input.length === 0) throw invalid('Path must not be empty');
  if (input.length > MAX_PATH_LENGTH) {
    throw invalid(`Path must be at most ${MAX_PATH_LENGTH} characters`);
  }
  if (input !== input.trim()) throw invalid('Path must not start or end with whitespace');
  if (CONTROL_CHARS.test(input)) throw invalid('Path must not contain control characters');
  if (input.includes('\\')) throw invalid('Path must use forward slashes');
  if (input.startsWith('/')) throw invalid('Path must be relative to the project root');
  if (input.endsWith('/')) throw invalid('Path must not end with a slash');

  const segments = input.split('/');
  if (segments.length > MAX_DEPTH) throw invalid(`Path must be at most ${MAX_DEPTH} levels deep`);

  for (const segment of segments) {
    if (segment.length === 0) throw invalid('Path must not contain an empty segment');
    if (segment === '.' || segment === '..') {
      throw invalid('Path must not contain "." or ".." segments');
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw invalid(`Each path segment must be at most ${MAX_SEGMENT_LENGTH} characters`);
    }
    if (segment !== segment.trim()) {
      throw invalid('Path segments must not start or end with whitespace');
    }
  }

  return input;
}

export function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

export function parentPath(path: string): string | undefined {
  const index = path.lastIndexOf('/');
  return index === -1 ? undefined : path.slice(0, index);
}

/** Every ancestor directory of a path, shallowest first: a/b/c.py -> [a, a/b] */
export function ancestorPaths(path: string): string[] {
  const segments = path.split('/');
  segments.pop();

  const ancestors: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    ancestors.push(segments.slice(0, i + 1).join('/'));
  }
  return ancestors;
}

/**
 * The trailing slash is the whole point: without it, renaming `src` would also
 * catch `src2/main.py`.
 */
export function isDescendantOf(path: string, directory: string): boolean {
  return path.startsWith(`${directory}/`);
}

export function replacePathPrefix(path: string, fromDir: string, toDir: string): string {
  return `${toDir}${path.slice(fromDir.length)}`;
}
