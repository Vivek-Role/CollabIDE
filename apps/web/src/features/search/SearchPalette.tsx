import { useEffect, useMemo, useRef, useState } from 'react';

import {
  Badge,
  EmptyState,
  FileIcon,
  SearchIcon,
  SpinnerIcon,
  TextIcon,
} from '../../components';
import type { TreeNode } from '../../lib/types';
import { Highlight } from './Highlight';
import type { FlatNode } from './match';
import { useProjectSearch } from './useProjectSearch';
import type { ContentHit, FileHit } from './useProjectSearch';

/**
 * The command palette: one input, two kinds of answer.
 *
 * Deliberately NOT built on `Dialog`. Dialog is a centred, max-w-lg box with a
 * title bar — right for a form, wrong for a palette, which wants to sit near
 * the top of the viewport at a wider measure and has no title. It reuses the
 * same backdrop treatment, the same Escape behaviour and the same tokens, so it
 * reads as part of the set without pretending to be a seventh primitive.
 *
 * Navigation is a flat index over a flat `rows` array. Grouping is drawn by
 * inserting a header when the row kind changes — the alternative, one index per
 * group plus a group index, is two cursors that have to agree, and they stop
 * agreeing the first time a group empties while the arrow key is held down.
 */

/** How the palette was opened. `files` is quick-open: no content search at all,
 *  which is the difference between Ctrl+P and Ctrl+K. */
export type PaletteMode = 'all' | 'files';

export interface RevealTarget {
  line: number;
  offset: number;
  /** The matched text, so the editor can re-find it if the document moved. */
  text: string;
}

type Row =
  | { kind: 'file'; key: string; hit: FileHit }
  | { kind: 'content'; key: string; hit: ContentHit };

/** Names are the fast answer, so more of them are worth showing; content rows
 *  are taller and the list is meant to be scanned, not paged. */
const MAX_FILE_ROWS = 40;

export function SearchPalette({
  projectId,
  tree,
  mode,
  recent,
  onOpen,
  onClose,
}: {
  projectId: string;
  tree: TreeNode[] | null;
  mode: PaletteMode;
  /** Most recently opened first. Shown when the query is empty. */
  recent: FlatNode[];
  onOpen: (node: FlatNode, target?: RevealTarget) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  const search = useProjectSearch(projectId, tree, query, mode === 'all');

  const trimmed = query.trim();

  const rows = useMemo<Row[]>(() => {
    if (trimmed.length === 0) {
      return recent.map((node) => ({
        kind: 'file' as const,
        key: `recent:${node.id}`,
        hit: { node, score: 0, ranges: [] },
      }));
    }

    const files: Row[] = search.files
      .slice(0, MAX_FILE_ROWS)
      .map((hit) => ({ kind: 'file' as const, key: `file:${hit.node.id}`, hit }));

    const contents: Row[] = search.contents.map((hit) => ({
      kind: 'content' as const,
      key: `content:${hit.node.id}:${hit.match.offset}`,
      hit,
    }));

    return [...files, ...contents];
  }, [trimmed, recent, search.files, search.contents]);

  // A query that changed has a different list under it; keeping the old index
  // would leave the highlight on whatever happens to be in that position now.
  useEffect(() => {
    setSelected(0);
  }, [trimmed]);

  // Clamp rather than reset: content results arrive progressively, and resetting
  // on every batch would drag the selection back to the top while it is in use.
  useEffect(() => {
    setSelected((current) => (current >= rows.length ? Math.max(0, rows.length - 1) : current));
  }, [rows.length]);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Keyboard scrolling has to move the viewport itself; the browser only does
  // that for focus, and focus stays in the input the whole time.
  useEffect(() => {
    const container = list.current;
    const active = container?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [selected, rows.length]);

  function choose(row: Row | undefined): void {
    if (!row) return;

    if (row.kind === 'file') {
      if (row.hit.node.isDir) return;
      onOpen(row.hit.node);
    } else {
      onOpen(row.hit.node, {
        line: row.hit.match.line,
        offset: row.hit.match.offset,
        text: trimmed,
      });
    }
    onClose();
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setSelected((current) => (rows.length === 0 ? 0 : (current + 1) % rows.length));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setSelected((current) =>
          rows.length === 0 ? 0 : (current - 1 + rows.length) % rows.length,
        );
        break;
      case 'Home':
        event.preventDefault();
        setSelected(0);
        break;
      case 'End':
        event.preventDefault();
        setSelected(Math.max(0, rows.length - 1));
        break;
      case 'Enter':
        event.preventDefault();
        choose(rows[selected]);
        break;
      case 'Escape':
        event.preventDefault();
        // Escape clears first and closes second: a long query typed by mistake
        // should not cost the palette as well.
        if (query.length > 0) setQuery('');
        else onClose();
        break;
      default:
        break;
    }
  }

  const fileCount = trimmed.length === 0 ? 0 : search.files.length;
  const searching = search.contentState === 'searching';

  return (
    <div
      className="dialog-backdrop-in fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[10vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search project"
        className="dialog-panel-in flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded border border-line bg-panel shadow-panel"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3">
          <SearchIcon className="h-4 w-4 shrink-0 text-muted" />

          {/* Not a `Field`: there is no label, no error and no hint here, and
              the palette's input is the whole surface rather than a control
              inside a form. */}
          <input
            ref={input}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              mode === 'files' ? 'Go to file…' : 'Search files and their contents…'
            }
            aria-label={mode === 'files' ? 'Go to file' : 'Search files and their contents'}
            aria-autocomplete="list"
            aria-controls="search-results"
            className="h-12 min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
          />

          {searching ? <SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-muted" /> : null}

          <kbd className="hidden shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-muted sm:block">
            Esc
          </kbd>
        </div>

        <div ref={list} id="search-results" role="listbox" className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="px-4 py-6">
              <EmptyState
                size="sm"
                bordered={false}
                icon={<SearchIcon className="h-5 w-5" />}
                title={
                  trimmed.length === 0
                    ? 'Search this project'
                    : searching
                      ? 'Searching…'
                      : 'No matches'
                }
                hint={
                  trimmed.length === 0
                    ? mode === 'files'
                      ? 'Type part of a file name.'
                      : 'Type a file name, or any text to find inside the project.'
                    : searching
                      ? undefined
                      : `Nothing matches “${trimmed}”.`
                }
              />
            </div>
          ) : (
            rows.map((row, index) => {
              const previous = rows[index - 1];
              const header =
                previous === undefined || previous.kind !== row.kind
                  ? trimmed.length === 0
                    ? 'Recently opened'
                    : row.kind === 'file'
                      ? `Files (${fileCount})`
                      : `In files (${search.contents.length}${search.capped ? '+' : ''})`
                  : null;

              return (
                <div key={row.key}>
                  {header ? (
                    <p className="sticky top-0 z-10 bg-panel px-3 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                      {header}
                    </p>
                  ) : null}

                  <ResultRow
                    row={row}
                    active={index === selected}
                    onHover={() => setSelected(index)}
                    onChoose={() => choose(row)}
                  />
                </div>
              );
            })
          )}
        </div>

        <PaletteFooter mode={mode} search={search} query={trimmed} />
      </div>
    </div>
  );
}

function ResultRow({
  row,
  active,
  onHover,
  onChoose,
}: {
  row: Row;
  active: boolean;
  onHover: () => void;
  onChoose: () => void;
}) {
  const node = row.hit.node;
  const directory = node.path.slice(0, Math.max(0, node.path.lastIndexOf('/')));

  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-active={active}
      onMouseMove={onHover}
      onClick={onChoose}
      className={[
        'flex w-full items-center gap-2 px-3 py-1.5 text-left outline-none',
        'transition-colors duration-100',
        active ? 'bg-elevated' : 'hover:bg-elevated-hover',
      ].join(' ')}
    >
      <span aria-hidden="true" className={`shrink-0 ${active ? 'text-accent' : 'text-muted'}`}>
        {row.kind === 'file' ? (
          <FileIcon className="h-3.5 w-3.5" />
        ) : (
          <TextIcon className="h-3.5 w-3.5" />
        )}
      </span>

      <span className="min-w-0 flex-1">
        {row.kind === 'file' ? (
          <span className="block truncate text-xs text-ink">
            <Highlight text={node.path} ranges={row.hit.ranges} />
          </span>
        ) : (
          <>
            <span className="block truncate font-mono text-[11px] text-ink">
              <Highlight text={row.hit.match.snippet} ranges={row.hit.match.ranges} />
            </span>
            <span className="block truncate text-[11px] text-muted">
              {node.name}
              {directory ? <span className="text-muted/70"> · {directory}</span> : null}
            </span>
          </>
        )}
      </span>

      {row.kind === 'content' ? (
        <Badge tone="neutral" className="shrink-0 font-mono">
          {row.hit.match.line}
        </Badge>
      ) : null}
    </button>
  );
}

/** Says what the search did and did not cover. Everything here is a fact the
 *  hook measured — nothing is estimated, and a skipped file is never silent. */
function PaletteFooter({
  mode,
  search,
  query,
}: {
  mode: PaletteMode;
  search: ReturnType<typeof useProjectSearch>;
  query: string;
}) {
  const notes: string[] = [];

  if (mode === 'files') {
    notes.push('File names only');
  } else if (search.contentState === 'searching') {
    notes.push(`Reading ${search.scanned}/${search.total} files`);
  } else if (search.contentState === 'done') {
    notes.push(`${search.total} files read`);
    if (search.skipped > 0) notes.push(`${search.skipped} skipped`);
    if (search.partial) notes.push('project truncated to the first 300 files');
    if (search.capped) notes.push('showing the first 120 matches');
  } else if (query.length === 1) {
    notes.push('Type one more character to search file contents');
  }

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-3 py-1.5">
      <span className="truncate text-[11px] text-muted">
        {search.error ?? notes.join(' · ')}
      </span>

      <span className="hidden shrink-0 items-center gap-2 text-[11px] text-muted sm:flex">
        <kbd className="rounded border border-line px-1 py-0.5 text-[10px]">↑↓</kbd>
        <kbd className="rounded border border-line px-1 py-0.5 text-[10px]">↵</kbd>
        open
      </span>
    </div>
  );
}
