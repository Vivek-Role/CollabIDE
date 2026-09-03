import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { AwarenessUser } from '@collab/shared';
import type { Awareness } from 'y-protocols/awareness';

/**
 * Who else is in THIS FILE.
 *
 * Per-open-file, and labelled that way on purpose (decision A2/D7). There is one
 * CollabProvider per open tab, so awareness is scoped to a document — this is
 * not, and must not imply, project-wide presence. Showing "who is in the
 * project" would need a server-side presence channel, which Phase 10 does not
 * build.
 *
 * ── Why this reads awareness directly ──────────────────────────────────────
 *
 * `CollabProvider.awareness` is a public readonly field and `Awareness` is its
 * own event emitter, so this component subscribes to it and **modifies nothing**:
 * CollabProvider.ts, useCollabDocs.ts and presence.ts are untouched by module
 * 10.4.
 *
 * `provider.onStatus` deliberately is NOT used. It is a single callback slot
 * already claimed by useCollabDocs's `rerender`, and the provider never fires it
 * on awareness changes — so a second consumer would have to modify the provider.
 *
 * This is a pure reader. It never calls setLocalState: presence is published by
 * CollabProvider on construct and again in handleOpen, and a second writer would
 * fight it.
 */

interface Peer {
  clientId: number;
  name: string;
  color: string;
}

/** Enough faces to read at a glance; the rest collapse into a +N. */
const MAX_FACES = 5;

export function Facepile({ awareness }: { awareness: Awareness }) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      // 'change' fires for added/updated/removed — including when a peer's
      // socket dies and the room drops their state.
      awareness.on('change', onChange);
      return () => awareness.off('change', onChange);
    },
    [awareness],
  );

  /**
   * useSyncExternalStore compares snapshots with Object.is, and
   * `awareness.getStates()` returns a NEW Map on every call — so returning a
   * freshly-derived array here would re-render forever. The snapshot is cached
   * against a primitive key and only rebuilt when that key actually changes.
   */
  const cache = useRef<{ key: string; peers: Peer[] }>({ key: '', peers: [] });

  const getSnapshot = useCallback((): Peer[] => {
    const peers: Peer[] = [];

    for (const [clientId, state] of awareness.getStates()) {
      // Our own client is in here too. Without this you appear in your own
      // facepile, which reads as a phantom second editor.
      if (clientId === awareness.clientID) continue;

      const user = (state as { user?: AwarenessUser } | undefined)?.user;
      if (!user) continue;

      peers.push({ clientId, name: user.name, color: user.color });
    }

    // Stable order, so faces do not shuffle when the Map's iteration order does.
    peers.sort((left, right) => left.clientId - right.clientId);

    const key = peers.map((peer) => `${peer.clientId}:${peer.name}:${peer.color}`).join('|');
    if (key !== cache.current.key) cache.current = { key, peers };

    return cache.current.peers;
  }, [awareness]);

  const peers = useSyncExternalStore(subscribe, getSnapshot);

  if (peers.length === 0) return null;

  const shown = peers.slice(0, MAX_FACES);
  const overflow = peers.length - shown.length;

  return (
    <span
      className="flex items-center gap-1"
      // The label carries the scope. The faces alone would imply the project.
      title={`In this file: ${peers.map((peer) => peer.name).join(', ')}`}
    >
      <span className="flex -space-x-1">
        {shown.map((peer) => (
          <span
            key={peer.clientId}
            aria-hidden="true"
            className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold text-surface ring-1 ring-panel"
            style={{ backgroundColor: peer.color }}
          >
            {(peer.name.trim()[0] ?? '?').toUpperCase()}
          </span>
        ))}
      </span>

      {overflow > 0 ? <span className="text-[11px] text-muted">+{overflow}</span> : null}

      <span className="sr-only">
        {peers.length} other {peers.length === 1 ? 'person' : 'people'} in this file
      </span>
    </span>
  );
}
