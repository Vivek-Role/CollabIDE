import type { TreeNode } from '../../lib/types';

/**
 * Everything about *how* a search matches — and nothing about where the data
 * came from or how it is drawn.
 *
 * Pure functions only: no React, no fetch, no imports beyond the shared types.
 * That is what lets the palette and the tree filter agree on one definition of
 * "matches", instead of two lowercase-includes calls that quietly diverge.
 */

/** A file or folder, lifted out of the nested tree into one flat list. */
export interface FlatNode {
  id: string;
  path: string;
  name: string;
  isDir: boolean;
  /** Carried so the content cache can key on it: an edited file misses the
   *  cache and is read again, an untouched one is not. */
  updatedAt: string;
}

/** A [start, end) slice of a string that the query matched, for highlighting. */
export interface Range {
  start: number;
  end: number;
}

/** Depth-first, preserving the server's order (directories first, then
 *  alphabetical). Nothing here sorts: the server already decided, once, so
 *  every client agrees — the same rule useFileTree follows. */
export function flattenTree(tree: TreeNode[] | null): FlatNode[] {
  const out: FlatNode[] = [];

  function walk(nodes: TreeNode[]): void {
    for (const node of nodes) {
      out.push({
        id: node.id,
        path: node.path,
        name: node.name,
        isDir: node.isDir,
        updatedAt: node.updatedAt,
      });
      walk(node.children);
    }
  }

  if (tree) walk(tree);
  return out;
}

/**
 * Paths that are almost never what a person is searching for, and are usually
 * enormous. Checked per path SEGMENT, so `src/nodes/` is not mistaken for
 * `node_modules`.
 */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.cache',
  '.turbo',
]);

/** Extensions whose contents are bytes, not text. Reading them would fill the
 *  snippet list with mojibake, so content search skips them — they are still
 *  found by NAME, which is what someone looking for `logo.png` wants anyway. */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'icns', 'tiff',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  'mp3', 'mp4', 'wav', 'ogg', 'webm', 'mov', 'avi', 'mkv', 'flac',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'class', 'pyc', 'o', 'a',
  'db', 'sqlite', 'sqlite3', 'lock',
]);

/** Beyond this a file is skipped rather than scanned: it is one fetch, one
 *  string and one scan on the main thread, and a 10 MB minified bundle is not
 *  what anyone means by "search my project". Reported as skipped, never
 *  silently dropped. */
export const MAX_SEARCHABLE_BYTES = 512_000;

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Whether this path's CONTENT is worth reading. Name search ignores this
 *  entirely — every file can be found by name. */
export function isContentSearchable(path: string): boolean {
  for (const segment of path.split('/')) {
    if (IGNORED_SEGMENTS.has(segment)) return false;
  }
  return !BINARY_EXTENSIONS.has(extensionOf(path));
}

/** A last line of defence for a text extension holding bytes anyway: a NUL in
 *  the first few KB means this is not text, whatever it is called. */
export function looksBinary(content: string): boolean {
  const head = Math.min(content.length, 4096);
  for (let index = 0; index < head; index += 1) {
    if (content.charCodeAt(index) === 0) return true;
  }
  return false;
}

/**
 * Name/path matching.
 *
 * Two tiers, in this order:
 *   1. a contiguous, case-insensitive substring — the common case, and the only
 *      one that produces a highlight a person recognises as "what I typed";
 *   2. a subsequence, so `usfl` finds `useFileTree.ts` the way an editor's
 *      quick-open does.
 *
 * Returns null for no match. Lower score is better, so callers sort ascending.
 */
export interface NameMatch {
  score: number;
  /** Ranges over the string that was passed in — a full path at the palette,
   *  a bare name at the tree filter. */
  ranges: Range[];
}

export function matchPath(path: string, query: string): NameMatch | null {
  if (query.length === 0) return null;

  const haystack = path.toLowerCase();
  const needle = query.toLowerCase();
  const nameStart = path.lastIndexOf('/') + 1;

  const direct = haystack.indexOf(needle);
  if (direct !== -1) {
    const inName = direct >= nameStart;
    // A hit in the file's own name beats one buried in a folder above it, and
    // a hit at the start of the name beats one in the middle.
    const base = inName ? (direct === nameStart ? 0 : 100) : 300;
    return { score: base + direct, ranges: [{ start: direct, end: direct + needle.length }] };
  }

  // Subsequence, scanned over the name first so `usfl` prefers useFileTree.ts
  // to `us/er/f/l`. Falls back to the whole path when the name cannot supply it.
  const inName = subsequenceRanges(haystack, needle, nameStart);
  if (inName) return { score: 1000 + inName.spread, ranges: inName.ranges };

  const anywhere = subsequenceRanges(haystack, needle, 0);
  if (anywhere) return { score: 2000 + anywhere.spread, ranges: anywhere.ranges };

  return null;
}

/** Greedy left-to-right subsequence. `spread` is how far apart the matched
 *  characters ended up — tighter matches rank higher. */
function subsequenceRanges(
  haystack: string,
  needle: string,
  from: number,
): { ranges: Range[]; spread: number } | null {
  const ranges: Range[] = [];
  let cursor = from;
  let first = -1;

  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found === -1) return null;

    if (first === -1) first = found;

    // Merge with the previous range when the characters are adjacent, so
    // "use" inside useFileTree draws as one highlight and not three.
    const last = ranges[ranges.length - 1];
    if (last && last.end === found) last.end = found + 1;
    else ranges.push({ start: found, end: found + 1 });

    cursor = found + 1;
  }

  return { ranges, spread: cursor - first - needle.length };
}

/** One matching line inside a file. */
export interface ContentMatch {
  /** 1-based, so it reads the same as the editor's gutter. */
  line: number;
  /** The line, trimmed of leading indentation and clipped around the match. */
  snippet: string;
  /** Ranges over `snippet`, not over the original line. */
  ranges: Range[];
  /** Offset of the match within the whole document — used to reveal it. */
  offset: number;
}

/** How much of a long line to keep on each side of the match. */
const SNIPPET_BEFORE = 32;
const SNIPPET_AFTER = 120;

/**
 * Literal, case-insensitive text search. Deliberately NOT a regex: a partially
 * typed regex is a syntax error on most keystrokes, and every `(` in a query
 * would otherwise throw or match nothing.
 *
 * At most `limit` matches per file, and at most one per line — a line holding
 * the query twenty times is one result, not twenty.
 */
export function matchContent(content: string, query: string, limit: number): ContentMatch[] {
  if (query.length === 0) return [];

  const haystack = content.toLowerCase();
  const needle = query.toLowerCase();

  const matches: ContentMatch[] = [];
  let cursor = 0;
  // Walking the newlines forward alongside the search keeps this O(n) rather
  // than counting newlines from the start for every hit.
  let line = 1;
  let lineStart = 0;
  let scanned = 0;

  while (matches.length < limit) {
    const found = haystack.indexOf(needle, cursor);
    if (found === -1) break;

    while (scanned < found) {
      if (content.charCodeAt(scanned) === 10) {
        line += 1;
        lineStart = scanned + 1;
      }
      scanned += 1;
    }

    let lineEnd = content.indexOf('\n', found);
    if (lineEnd === -1) lineEnd = content.length;

    const raw = content.slice(lineStart, lineEnd);
    const column = found - lineStart;

    // Clip a long line around the match, and drop indentation, so the snippet
    // shows the code rather than sixty columns of whitespace.
    const indent = raw.length - raw.trimStart().length;
    const from = Math.max(indent, column - SNIPPET_BEFORE);
    const to = Math.min(raw.length, column + needle.length + SNIPPET_AFTER);

    const prefix = from > indent ? '…' : '';
    const suffix = to < raw.length ? '…' : '';
    const start = prefix.length + (column - from);

    matches.push({
      line,
      snippet: prefix + raw.slice(from, to) + suffix,
      ranges: [{ start, end: start + needle.length }],
      offset: found,
    });

    // One result per line: jump past this line entirely.
    cursor = lineEnd + 1;
  }

  return matches;
}

/**
 * Filter a nested tree to the nodes whose NAME matches, keeping every ancestor
 * of a kept node so the result is still a tree and not a flat list wearing
 * indentation.
 *
 * A directory that matches by name keeps its whole subtree — filtering for
 * `src` and getting an empty `src/` would be a strange answer.
 *
 * Non-destructive by construction: it returns new arrays and never mutates the
 * tree `useFileTree` owns, so clearing the filter restores the original object
 * rather than a rebuilt copy.
 */
export function filterTree(tree: TreeNode[], query: string): TreeNode[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return tree;

  function walk(nodes: TreeNode[]): TreeNode[] {
    const kept: TreeNode[] = [];

    for (const node of nodes) {
      const self = matchPath(node.name, trimmed) !== null;

      if (node.isDir) {
        if (self) {
          kept.push(node);
          continue;
        }
        const children = walk(node.children);
        if (children.length > 0) kept.push({ ...node, children });
      } else if (self) {
        kept.push(node);
      }
    }

    return kept;
  }

  return walk(tree);
}

/** Every directory path in a (filtered) tree, so the sidebar can open all of
 *  them — a filter whose hits sit inside collapsed folders shows nothing. */
export function directoryPaths(tree: TreeNode[]): string[] {
  const paths: string[] = [];

  function walk(nodes: TreeNode[]): void {
    for (const node of nodes) {
      if (node.isDir) {
        paths.push(node.path);
        walk(node.children);
      }
    }
  }

  walk(tree);
  return paths;
}
