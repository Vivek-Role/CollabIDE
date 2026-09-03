import { useEffect, useMemo, useRef, useState } from 'react';

import {
  Alert,
  Button,
  CloseIcon,
  Dialog,
  EmptyState,
  FileIcon,
  PlusIcon,
  SearchIcon,
} from '../../components';
import type { TreeNode as FileTreeNode } from '../../lib/types';
import { directoryPaths, filterTree } from '../search';
import { toFileMessage } from './errors';
import { NewNodeDialog } from './NewNodeDialog';
import { RenameDialog } from './RenameDialog';
import { TreeNode } from './TreeNode';

/** How long the "Deleted N items." confirmation stays up (defect D6). */
const STATUS_TIMEOUT_MS = 4000;

/**
 * The sidebar: a filter, the tree, and the three dialogs that change it.
 *
 * Data and expand/select state live in the page above; this component owns only
 * which dialog is open and what the filter box says. Keeping the tree data out
 * of here is what lets module 2.4 read the same selection without going through
 * the sidebar.
 *
 * ── The filter (module 12.2) ───────────────────────────────────────────────
 *
 * `filterTree` returns a NEW tree and never touches the one `useFileTree`
 * owns, so clearing the box restores the original object rather than a rebuilt
 * copy — no refetch, and nothing in the tree can be lost by typing in a text
 * box. While a filter is active every surviving directory is drawn open,
 * because hits inside a collapsed folder are hits nobody can see. That override
 * is computed for the render and is NOT written into the page's `expanded` set:
 * clearing the filter leaves the folders exactly as they were before it.
 */
export function FileTree({
  tree,
  loading,
  error,
  canEdit,
  expanded,
  selectedId,
  onToggle,
  onSelect,
  onCreate,
  onMove,
  onDelete,
  onOpenSearch,
}: {
  tree: FileTreeNode[] | null;
  loading: boolean;
  error: string | null;
  canEdit: boolean;
  expanded: Set<string>;
  selectedId: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: FileTreeNode) => void;
  onCreate: (path: string, isDir: boolean) => Promise<void>;
  onMove: (fileId: string, path: string) => Promise<void>;
  onDelete: (fileId: string) => Promise<number>;
  /** Opens the project-wide palette — the tree filter searches names only. */
  onOpenSearch: () => void;
}) {
  const [newIn, setNewIn] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<FileTreeNode | null>(null);
  const [deleting, setDeleting] = useState<FileTreeNode | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const filterInput = useRef<HTMLInputElement | null>(null);

  const query = filter.trim();

  const filtered = useMemo(
    () => (tree === null ? null : filterTree(tree, query)),
    [tree, query],
  );

  const effectiveExpanded = useMemo(() => {
    if (query.length === 0 || filtered === null) return expanded;
    return new Set([...expanded, ...directoryPaths(filtered)]);
  }, [expanded, filtered, query]);

  /**
   * Defect D6, fixed in module 10.3.
   *
   * The delete confirmation used to be set and never cleared, so "Deleted 3
   * items." sat at the bottom of the sidebar for the rest of the session,
   * describing something that happened minutes ago. It now expires, and the
   * timer is cleared on unmount and whenever the message changes — a pending
   * timeout that outlives the component would set state on a dead one.
   */
  useEffect(() => {
    if (status === null) return;

    const timer = setTimeout(() => setStatus(null), STATUS_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status]);

  async function handleDelete(node: FileTreeNode) {
    setBusy(true);
    setDeleteError(null);

    try {
      const deleted = await onDelete(node.id);
      // The server reports how many rows went, which for a folder is the whole
      // subtree. Showing it is the only feedback that the cascade did what the
      // confirmation said it would.
      setStatus(`Deleted ${deleted} item${deleted === 1 ? '' : 's'}.`);
      setDeleting(null);
    } catch (caught) {
      setDeleteError(toFileMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const emptyProject = filtered !== null && tree?.length === 0;
  const emptyFilter = filtered !== null && filtered.length === 0 && (tree?.length ?? 0) > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted">Files</h2>

        <div className="flex items-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSearch}
            aria-label="Search project"
            title="Search files and contents (Ctrl+K)"
            className="h-6 px-1"
          >
            <SearchIcon className="h-3.5 w-3.5" />
          </Button>

          {canEdit ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setNewIn('')}
              aria-label="New file or folder"
              title="New file or folder"
              className="h-6 px-1"
            >
              <PlusIcon className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* Live, local and destructive of nothing. Escape clears it, which is the
          one keystroke people try before reaching for the ×. */}
      <div className="relative shrink-0 border-b border-line px-2 py-1.5">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute left-4 top-1/2 h-3 w-3 -translate-y-1/2 text-muted"
        />
        <input
          ref={filterInput}
          type="text"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && filter.length > 0) {
              event.stopPropagation();
              setFilter('');
            }
          }}
          placeholder="Filter files"
          aria-label="Filter files by name"
          className="h-7 w-full rounded border border-line bg-surface pl-7 pr-7 text-xs text-ink outline-none transition-colors duration-100 placeholder:text-muted hover:border-line-strong focus-visible:ring-2 focus-visible:ring-focus"
        />
        {filter.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setFilter('');
              filterInput.current?.focus();
            }}
            aria-label="Clear filter"
            title="Clear filter"
            className="absolute right-3.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted outline-none transition-colors duration-100 hover:bg-elevated-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
          >
            <CloseIcon className="h-3 w-3" />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loading ? <p className="px-3 py-2 text-xs text-muted">Loading…</p> : null}

        {!loading && error ? (
          <div className="px-2 py-2">
            <Alert>{error}</Alert>
          </div>
        ) : null}

        {!loading && !error && emptyProject ? (
          <div className="px-2 py-4">
            <EmptyState
              size="sm"
              bordered={false}
              icon={<FileIcon className="h-5 w-5" />}
              title="No files yet"
              hint={canEdit ? 'Use + to add one.' : undefined}
            />
          </div>
        ) : null}

        {!loading && !error && emptyFilter ? (
          <div className="px-2 py-4">
            <EmptyState
              size="sm"
              bordered={false}
              icon={<SearchIcon className="h-5 w-5" />}
              title="No files match"
              hint={`Nothing here is called “${query}”. Ctrl+K searches file contents too.`}
              action={
                <Button size="sm" onClick={() => setFilter('')}>
                  Clear filter
                </Button>
              }
            />
          </div>
        ) : null}

        {!loading && !error && filtered && filtered.length > 0 ? (
          <ul>
            {filtered.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                depth={0}
                handlers={{
                  expanded: effectiveExpanded,
                  selectedId,
                  canEdit,
                  highlight: query,
                  onToggle,
                  onSelect,
                  onNew: (parentPath) => setNewIn(parentPath),
                  onRename: (target) => setRenaming(target),
                  onDelete: (target) => {
                    setDeleteError(null);
                    setDeleting(target);
                  },
                }}
              />
            ))}
          </ul>
        ) : null}
      </div>

      {status ? (
        <p
          role="status"
          className="shrink-0 border-t border-line px-3 py-1.5 text-[11px] text-muted"
        >
          {status}
        </p>
      ) : null}

      {newIn !== null ? (
        <NewNodeDialog
          // Prefilled with the folder that was clicked, so the common case is
          // typing a name — but the whole path stays editable.
          initialPath={newIn === '' ? '' : `${newIn}/`}
          onCreate={onCreate}
          onClose={() => setNewIn(null)}
        />
      ) : null}

      {renaming ? (
        <RenameDialog node={renaming} onMove={onMove} onClose={() => setRenaming(null)} />
      ) : null}

      {deleting ? (
        <Dialog
          title="Delete"
          size="sm"
          onClose={() => (busy ? undefined : setDeleting(null))}
          footer={
            <>
              <Button onClick={() => setDeleting(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void handleDelete(deleting)} loading={busy}>
                {busy ? 'Deleting…' : 'Delete'}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <p className="text-sm text-ink">
              Delete <span className="font-mono text-xs">{deleting.path}</span>?
            </p>
            {deleting.isDir ? (
              <p className="text-xs text-muted">
                Everything inside this folder is deleted with it. This cannot be undone.
              </p>
            ) : (
              <p className="text-xs text-muted">This cannot be undone.</p>
            )}

            {deleteError ? <Alert>{deleteError}</Alert> : null}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
