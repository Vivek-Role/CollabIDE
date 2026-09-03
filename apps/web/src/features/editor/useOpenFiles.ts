import { useCallback, useState } from 'react';


/**
 * The open tabs — and, since module 3.5, nothing else.
 *
 * A tab is now just a label: id, path, name. The file's text lives in the Yjs
 * document behind its collab provider, which is the only source of truth for it.
 * Holding a copy here as React state is what produced the Phase 2 bug where a
 * stale cache overwrote the server's content (D1).
 *
 * That also means opening a tab costs no request: module 1.5's
 * GET /files/:fileId is no longer called, and neither is the PUT that module 2.4
 * used to save with. Durability is module 3.3b's flush when the last editor
 * leaves, until Phase 4 replaces it.
 */

export interface OpenTab {
  id: string;
  path: string;
  name: string;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** How many recently-opened files the palette offers when its box is empty.
 *  Ten is one screenful; beyond that the list stops being 'recent'. */
const MAX_RECENT = 10;

export function useOpenFiles() {
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * Ids only, most recent first, and deliberately NOT pruned when a tab closes
   * — a file you closed a minute ago is exactly what 'recent' means. Ids rather
   * than tabs because a path can change under a rename; the caller resolves
   * each id against the current tree, which also drops anything deleted.
   */
  const [recentIds, setRecentIds] = useState<string[]>([]);

  // Widened from TreeNode in module 12.1 so the search palette can open a
  // result: it holds a FlatNode, and only these two fields were ever read.
  const openFile = useCallback((node: { id: string; path: string }) => {
    setTabs((previous) =>
      previous.some((tab) => tab.id === node.id)
        ? previous
        : [...previous, { id: node.id, path: node.path, name: baseName(node.path) }],
    );
    setActiveId(node.id);
    setRecentIds((previous) => [node.id, ...previous.filter((id) => id !== node.id)].slice(0, MAX_RECENT));
  }, []);

  const closeFile = useCallback((fileId: string) => {
    setTabs((previous) => {
      const remaining = previous.filter((tab) => tab.id !== fileId);

      setActiveId((current) => {
        if (current !== fileId) return current;
        return remaining.length > 0 ? (remaining[remaining.length - 1]?.id ?? null) : null;
      });

      return remaining;
    });
  }, []);

  /** A move keeps the row's id, so the tab follows its file to the new path. */
  const renameTab = useCallback((fileId: string, path: string) => {
    setTabs((previous) =>
      previous.map((tab) => (tab.id === fileId ? { ...tab, path, name: baseName(path) } : tab)),
    );
  }, []);

  return { tabs, activeId, recentIds, setActiveId, openFile, closeFile, renameTab };
}
