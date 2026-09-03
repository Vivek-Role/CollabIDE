import { useCallback, useEffect, useState } from 'react';

import { api } from '../../lib/api';
import type { DeleteResponse, FileRecord, FileResponse, TreeNode, TreeResponse } from '../../lib/types';
import { toFileMessage } from './errors';

/**
 * The project's file tree.
 *
 * The server returns it already nested and already sorted — directories first,
 * then alphabetical, decided once on the server so every client agrees
 * (module 1.5). Nothing here builds a tree or sorts one; a client-side sort
 * would be a bug waiting for the first rename.
 *
 * Mutations refetch instead of patching. Renaming a directory rewrites the path
 * of every descendant inside a server transaction, and reproducing that here
 * would mean two implementations of the same rule — which is exactly how the
 * two drift apart.
 */

/** Every ancestor directory of a path, shallowest first: a/b/c.py -> [a, a/b].
 *  Mirrors ancestorPaths in the server's paths.ts; used only to expand folders
 *  after a create, never to construct a path that is sent anywhere. */
export function ancestorPaths(path: string): string[] {
  const segments = path.split('/');
  segments.pop();

  const ancestors: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index + 1).join('/'));
  }
  return ancestors;
}

/**
 * A node's own id plus every id underneath it.
 *
 * Deleting a directory cascades on the server, which reports only how many rows
 * went — not which ones. The tree the client already holds is enough to work
 * that out, so this walks it rather than asking for anything new.
 *
 * **Call this before the delete:** `deleteNode` refetches, and by then the
 * subtree is gone from the tree and there is nothing left to walk.
 */
export function subtreeIds(tree: TreeNode[] | null, fileId: string): string[] {
  function find(nodes: TreeNode[]): TreeNode | null {
    for (const node of nodes) {
      if (node.id === fileId) return node;

      const found = find(node.children);
      if (found) return found;
    }
    return null;
  }

  function collect(node: TreeNode): string[] {
    return [node.id, ...node.children.flatMap(collect)];
  }

  // A file has no children, so this also covers the single-file case — and if
  // the tree has not loaded, the id the caller passed is still the right answer.
  const target = tree ? find(tree) : null;
  return target ? collect(target) : [fileId];
}

export function useFileTree(projectId: string) {
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const base = `/projects/${projectId}/files`;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await api.get<TreeResponse>(base);
      setTree(response.tree);
    } catch (caught) {
      setError(toFileMessage(caught));
      setTree(null);
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * One request, full path. Missing parent directories are created by the
   * server in the same transaction (service.ts), which is why the client never
   * walks a path creating levels — and why the dialog asks for a path, not a
   * name.
   *
   * Returns the created record so the caller can expand its ancestors; a folder
   * created collapsed would hide the file the user just made.
   */
  const createNode = useCallback(
    async (path: string, isDir: boolean): Promise<FileRecord> => {
      const response = await api.post<FileResponse>(base, { path, isDir });
      await refresh();
      return response.file;
    },
    [base, refresh],
  );

  /** Rename and move are the same operation: a new full path. Descendants
   *  follow server-side. */
  const moveNode = useCallback(
    async (fileId: string, path: string): Promise<FileRecord> => {
      const response = await api.patch<FileResponse>(`${base}/${fileId}`, { path });
      await refresh();
      return response.file;
    },
    [base, refresh],
  );

  /** Resolves to the number of rows removed — the whole subtree for a
   *  directory, so the user can be shown what actually went. */
  const deleteNode = useCallback(
    async (fileId: string): Promise<number> => {
      const response = await api.delete<DeleteResponse>(`${base}/${fileId}`);
      await refresh();
      return response.deleted;
    },
    [base, refresh],
  );

  return { tree, loading, error, refresh, createNode, moveNode, deleteNode };
}
