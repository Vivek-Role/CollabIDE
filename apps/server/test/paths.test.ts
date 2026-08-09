import { describe, expect, it } from 'vitest';

import {
  MAX_DEPTH,
  MAX_PATH_LENGTH,
  MAX_SEGMENT_LENGTH,
  ancestorPaths,
  assertValidPath,
  baseName,
  isDescendantOf,
  parentPath,
  replacePathPrefix,
} from '../src/modules/files/paths.js';

/**
 * Pure unit tests — no database, no HTTP. This is the file where the traversal
 * cases belong, and where they can be enumerated cheaply.
 */

const VALID = [
  'main.py',
  'src/main.py',
  'a/b/c/d/e.txt',
  'file-with-dashes.py',
  'file_with_underscores.py',
  'file.with.dots.py',
  'spaces in name.py',
  '100%.py', // a LIKE wildcard — must be ordinary here
  'under_score/50%off.txt',
  'Ünïcödé.py',
  '.gitignore',
  '.github/workflows/ci.yml',
];

const INVALID: Array<[string, unknown]> = [
  ['empty', ''],
  ['absolute', '/etc/passwd'],
  ['parent traversal', '../../etc/passwd'],
  ['embedded traversal', 'src/../../etc/passwd'],
  ['single dot segment', 'a/./b'],
  ['double slash', 'src//main.py'],
  ['trailing slash', 'src/'],
  ['backslash', 'src\\main.py'],
  ['windows absolute', 'C:\\Windows\\system32'],
  ['NUL byte', 'src/main.py\u0000.txt'],
  ['newline', 'src/main\n.py'],
  ['tab', 'src/\tmain.py'],
  ['leading whitespace', ' src/main.py'],
  ['trailing whitespace', 'src/main.py '],
  ['segment with trailing space', 'src /main.py'],
  ['bare dot', '.'],
  ['bare dotdot', '..'],
  ['not a string', 42],
  ['null', null],
];

describe('assertValidPath', () => {
  it.each(VALID)('accepts %s', (path) => {
    expect(assertValidPath(path)).toBe(path);
  });

  it.each(INVALID)('rejects %s', (_label, path) => {
    expect(() => assertValidPath(path)).toThrowError();
    try {
      assertValidPath(path);
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: 'INVALID_PATH' });
    }
  });

  it('returns the path completely unchanged', () => {
    // Never silently sanitized — the client and server must agree on the exact
    // string that now exists.
    const path = 'src/deeply/nested/file.name.py';
    expect(assertValidPath(path)).toBe(path);
  });

  it('enforces the length limits', () => {
    expect(() => assertValidPath('a'.repeat(MAX_SEGMENT_LENGTH + 1))).toThrowError();
    expect(() => assertValidPath('a'.repeat(MAX_PATH_LENGTH + 1))).toThrowError();

    const tooDeep = Array.from({ length: MAX_DEPTH + 1 }, (_v, i) => `d${i}`).join('/');
    expect(() => assertValidPath(tooDeep)).toThrowError();

    // ...and accepts the boundary itself.
    expect(assertValidPath('a'.repeat(MAX_SEGMENT_LENGTH))).toHaveLength(MAX_SEGMENT_LENGTH);
  });
});

describe('path helpers', () => {
  it('splits base and parent', () => {
    expect(baseName('src/main.py')).toBe('main.py');
    expect(baseName('main.py')).toBe('main.py');
    expect(parentPath('src/main.py')).toBe('src');
    expect(parentPath('main.py')).toBeUndefined();
  });

  it('lists ancestors shallowest first', () => {
    expect(ancestorPaths('a/b/c.py')).toEqual(['a', 'a/b']);
    expect(ancestorPaths('main.py')).toEqual([]);
  });

  it('does not treat a sibling with a shared prefix as a descendant', () => {
    // The bug this whole helper exists to prevent.
    expect(isDescendantOf('src/main.py', 'src')).toBe(true);
    expect(isDescendantOf('src2/main.py', 'src')).toBe(false);
    expect(isDescendantOf('srcx', 'src')).toBe(false);
    expect(isDescendantOf('src', 'src')).toBe(false);
  });

  it('rewrites a prefix without touching the rest', () => {
    expect(replacePathPrefix('src/a/b.py', 'src', 'lib')).toBe('lib/a/b.py');
    expect(replacePathPrefix('src/src/x.py', 'src', 'lib')).toBe('lib/src/x.py');
  });
});
