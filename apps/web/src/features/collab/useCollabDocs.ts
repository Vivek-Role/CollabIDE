import { useEffect, useReducer, useRef } from 'react';

import { useAuth } from '../auth';
import { CollabProvider } from './CollabProvider';
import { presenceFor } from './presence';

/**
 * One provider — one socket — per open tab, kept alive for as long as the tab is.
 *
 * The alternative, a single provider for whichever tab is active, would tear the
 * document down and re-sync it on every tab switch, and every cached EditorState
 * would be pointing at a destroyed Y.Text. Documents are small and sockets are
 * cheap; multiplexing them onto one connection is a Phase 7/8 optimisation with
 * measurements behind it.
 */
export function useCollabDocs(
  projectId: string,
  fileIds: string[],
): Map<string, CollabProvider> {
  const { user } = useAuth();
  const providers = useRef(new Map<string, CollabProvider>());
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  // A string, so the effect depends on which tabs are open rather than on the
  // identity of a fresh array on every render.
  const key = fileIds.join('\0');

  useEffect(() => {
    if (!user) return;

    const wanted = new Set(key.length > 0 ? key.split('\0') : []);
    const live = providers.current;

    for (const fileId of wanted) {
      if (live.has(fileId)) continue;

      const provider = new CollabProvider(projectId, fileId, presenceFor(user));
      provider.onStatus = rerender;
      live.set(fileId, provider);
    }

    for (const [fileId, provider] of [...live]) {
      if (wanted.has(fileId)) continue;

      provider.destroy();
      live.delete(fileId);
    }

    rerender();
  }, [projectId, key, user]);

  // Closing the page, navigating away, or StrictMode's simulated unmount: every
  // socket goes. destroy() is idempotent, so the remount that follows in
  // development ends with exactly one socket per tab.
  useEffect(() => {
    const live = providers.current;

    return () => {
      for (const provider of live.values()) provider.destroy();
      live.clear();
    };
  }, []);

  return providers.current;
}
