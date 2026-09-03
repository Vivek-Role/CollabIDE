import { useSyncExternalStore } from 'react';
import { CloseCode } from '@collab/shared';

import { Alert, Badge, EmptyState, FileIcon } from '../../components';
import { Facepile, useCollabDocs } from '../collab';
import type { CollabProvider } from '../collab';
import { CodeMirror } from './CodeMirror';
import type { RevealRequest } from './CodeMirror';
import { CopyPathButton } from './CopyPathButton';
import { Tabs } from './Tabs';
import type { OpenTab } from './useOpenFiles';

/**
 * Tabs, the editor, and a status line.
 *
 * The status line reports the *connection*, not the document: since module 3.5
 * there is nothing to save, so "Saved"/"Unsaved" would be meaningless. One
 * socket per open tab lives here, in the one component that knows which tabs
 * are open.
 *
 * Module 10.4 restyled this file and added the facepile. It changed how the
 * connection state is DRAWN and nothing about how it is COMPUTED: the three
 * functions below are byte-for-byte what they were, including the precedence
 * that lets "Read only" win over everything.
 */

function subscribeToOnline(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);

  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

/** An external, mutable browser value — which is what useSyncExternalStore is
 *  for. It labels the connection and nothing else: whether the *document* is
 *  ready is decided by the local store and the socket (module 5.1), never by
 *  this flag. The server snapshot is unreachable; apps/web does not SSR. */
function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeToOnline,
    () => navigator.onLine,
    () => true,
  );
}

/**
 * Why the socket closed for good.
 *
 * Since module 5.2, `closed` means **terminal**: a dropped connection retries
 * itself with backoff and stays `reconnecting`, so it never reaches this
 * function — which is why none of these strings tell you to reload except where
 * reloading is genuinely the answer.
 *
 * The wording is deliberately not @collab/shared's `closeReason()`: that text is
 * for logs, and it is vague on purpose about which 4401 happened.
 */
function closedMessage(provider: CollabProvider): string {
  switch (provider.closeCode) {
    case CloseCode.Gone:
      return 'This file, or your access to it, has changed. Reload to continue.';
    case CloseCode.NotFound:
      return 'This file is no longer available.';
    case CloseCode.Forbidden:
      return 'You do not have permission to open this file.';
    case CloseCode.Unauthenticated:
      return 'Your session has expired. Sign in again.';
    case CloseCode.BadRequest:
      return 'This document could not be opened.';
    default:
      return 'This document is no longer connected. Reload to try again.';
  }
}

/**
 * Shown instead of the editor while the provider is not `ready` — a file this
 * device has no local copy of, whose text has not arrived yet. Offline with a
 * local copy mounts the editor instead; this is the one combination where there
 * is genuinely nothing to edit.
 */
function placeholderMessage(provider: CollabProvider | undefined, online: boolean): string {
  if (provider?.status === 'closed') return 'Nothing to show for this file.';

  if (provider?.status === 'reconnecting') {
    return online
      ? 'Not connected. This file has not been opened on this device yet, so there is nothing to show until the connection returns.'
      : 'Offline. This file has not been opened on this device yet, so there is nothing to show until the connection returns.';
  }

  return 'Connecting…';
}

function statusLabel(
  readOnly: boolean,
  provider: CollabProvider | undefined,
  online: boolean,
): string {
  // Read only wins: a VIEWER cannot type whatever the socket is doing.
  if (readOnly) return 'Read only';

  switch (provider?.status) {
    case 'synced':
      return 'Live';
    case 'closed':
      return 'Disconnected';
    case 'reconnecting':
      // Offline is a label, not a provider state — and only the false direction
      // of navigator.onLine is trusted. On a captive portal it stays
      // "Reconnecting…", which is still true.
      return online ? 'Reconnecting…' : 'Offline';
    default:
      // 'connecting' is the first socket only; 5.2 never returns to it. Opening
      // with no network sits here for a second or two before the socket fails,
      // and "Connecting…" would be a lie for all of it.
      return online ? 'Connecting…' : 'Offline';
  }
}

/**
 * Colour for a label, derived FROM the label rather than recomputed from
 * provider state. One source of truth means the dot and the word can never
 * disagree — which they would the first time someone edited statusLabel and not
 * its twin.
 */
function statusTone(label: string): 'success' | 'warn' | 'danger' | 'neutral' {
  switch (label) {
    case 'Live':
      return 'success';
    case 'Reconnecting…':
    case 'Offline':
      return 'warn';
    case 'Disconnected':
      return 'danger';
    default:
      // 'Read only' and 'Connecting…' are states, not problems.
      return 'neutral';
  }
}

export function EditorPane({
  projectId,
  tabs,
  activeId,
  readOnly,
  reveal,
  onSelectTab,
  onCloseTab,
}: {
  projectId: string;
  tabs: OpenTab[];
  activeId: string | null;
  readOnly: boolean;
  /** Where a search result asked the editor to go. Passed straight through —
   *  this component takes no view on it. */
  reveal: RevealRequest | null;
  onSelectTab: (fileId: string) => void;
  onCloseTab: (fileId: string) => void;
}) {
  const providers = useCollabDocs(
    projectId,
    tabs.map((tab) => tab.id),
  );
  const online = useOnline();

  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const provider = active ? providers.get(active.id) : undefined;

  if (!active) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          bordered={false}
          icon={<FileIcon className="h-6 w-6" />}
          title="No file open"
          hint="Select a file from the tree to start editing."
        />
      </div>
    );
  }

  const label = statusLabel(readOnly, provider, online);

  return (
    <div className="flex h-full flex-col">
      <Tabs tabs={tabs} activeId={activeId} onSelect={onSelectTab} onClose={onCloseTab} />

      <div className="min-h-0 flex-1">
        {/* Mounted once the document exists — from IndexedDB or from the server,
            whichever answered first (module 5.1). Not on `status`: an offline tab
            with a local copy has a real document and no connection. Waiting is
            still right when there is no copy at all, because typing into a
            document that has not arrived interleaves your text with it the
            moment it lands.

            **Module 10.4 did not touch this element.** Its position, its props
            and its absence of a `key` are load-bearing: CodeMirror caches one
            EditorState per open document INSIDE the component, so remounting it
            silently discards cursor position and undo history on every tab
            switch. It typechecks and looks perfect when broken. */}
        {provider?.ready ? (
          <CodeMirror
            docId={active.id}
            path={active.path}
            ytext={provider.ytext}
            awareness={provider.awareness}
            readOnly={readOnly}
            openDocIds={tabs.map((tab) => tab.id)}
            reveal={reveal}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6">
            {/* Says only that there is nothing to show. The reason lives in the
                alert below, which is the one place a terminal message is
                rendered — printing it here as well showed the same sentence
                twice for a file this device had never opened. */}
            <p className="max-w-md text-center text-xs text-muted">
              {placeholderMessage(provider, online)}
            </p>
          </div>
        )}
      </div>

      <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-line bg-panel px-3">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate font-mono text-[11px] text-muted">{active.path}</span>
          <CopyPathButton path={active.path} />
        </span>

        <span className="flex shrink-0 items-center gap-3">
          {/* Per-open-file presence (A2). Renders nothing when you are alone. */}
          {provider ? <Facepile awareness={provider.awareness} /> : null}

          <span className="flex items-center gap-1.5">
            <Badge tone={statusTone(label)} dot />
            <span className="text-[11px] text-muted">{label}</span>
          </span>
        </span>
      </div>

      {provider?.status === 'closed' ? (
        <div className="shrink-0 border-t border-line px-3 py-1.5">
          <Alert>{closedMessage(provider)}</Alert>
        </div>
      ) : null}
    </div>
  );
}
