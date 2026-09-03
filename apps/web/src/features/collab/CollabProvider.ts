import { MessageType, WS_DOC_PARAM, WS_PATH, Y_TEXT_KEY, makeDocId } from '@collab/shared';
import type { AwarenessUser } from '@collab/shared';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { IndexeddbPersistence } from 'y-indexeddb';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { backoffDelay, isTerminalClose } from './reconnect';

/**
 * One document, one socket, one local store.
 *
 * The browser half of the protocol module 3.4 speaks: send sync step 1 on open,
 * apply what arrives, publish local changes and presence. Yjs merges; this class
 * only moves bytes.
 *
 * Module 5.1 added `y-indexeddb`, so a document you have already opened survives
 * a refresh with no network. **There is no offline queue and there must never be
 * one**: updates made while the socket is down stay in the Y.Doc, and the sync
 * step 1 / step 2 exchange carries whatever the server missed.
 *
 * Module 5.2 made the socket replaceable — backoff and jitter on a retryable
 * close, give up for good on a terminal one. **What is replaced is the socket
 * and only the socket**: the Y.Doc, its text, awareness and the mounted editor
 * all survive, so a network blink costs nothing, not even the cursor.
 */

export type CollabStatus = 'connecting' | 'synced' | 'reconnecting' | 'closed';

/** Applied traffic is tagged so the update listener does not send it back. */
const REMOTE = 'remote';

export class CollabProvider {
  readonly ydoc = new Y.Doc();
  readonly ytext: Y.Text;
  readonly awareness: Awareness;

  status: CollabStatus = 'connecting';

  /** Meaningful when the status is 'closed' — the reason it will not retry. */
  closeCode = 0;
  closeReason = '';

  /**
   * There is a document to show — from the local store or from the server,
   * whichever answers first. Never set back to false.
   *
   * Deliberately separate from `status`: `ready` is about the *document*,
   * `status` is about the *connection*, and offline with a local copy is
   * `ready: true, status: 'closed'`. Collapsing the two is what would make the
   * editor refuse to mount without a server.
   */
  ready = false;

  /** Called on every status or readiness change so React can re-render. */
  onStatus?: () => void;

  private readonly local: IndexeddbPersistence;
  private readonly url: string;
  private readonly user: AwarenessUser;

  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private destroyed = false;

  constructor(projectId: string, fileId: string, user: AwarenessUser) {
    this.user = user;
    this.ytext = this.ydoc.getText(Y_TEXT_KEY);
    this.awareness = new Awareness(this.ydoc);

    // Nested under `user` because that is the field y-codemirror.next reads to
    // label and colour a remote caret; a flat {name, color} renders as
    // "Anonymous" in its default blue. This also replaces the empty state a new
    // Awareness gives itself, which would otherwise be a cursor belonging to
    // nobody.
    this.awareness.setLocalState({ user });

    const docId = makeDocId(projectId, fileId);

    // The same id the socket and the server's update log use — one name for a
    // document, not three. Loads whatever is stored into the Y.Doc, then writes
    // every later update back.
    this.local = new IndexeddbPersistence(docId, this.ydoc);

    void this.local.whenSynced.then(() => {
      // whenSynced resolves for an empty database too — a file this browser has
      // never opened — and mounting on that would show an empty editor someone
      // could type into before the server answers. A fresh Y.Doc encodes a state
      // vector of one byte (zero clients); anything restored makes it longer.
      // That is also right for a document whose text was deleted down to "":
      // it still has items, so it still opens offline.
      if (Y.encodeStateVector(this.ydoc).byteLength > 1) this.setReady();
    });

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

    // Same origin as the page, so Vite proxies it to the API in dev and the
    // httpOnly session cookie travels with the upgrade — no token in the URL.
    // Built once and reused by every reconnect: a retry is the same request.
    this.url = `${scheme}//${window.location.host}${WS_PATH}?${WS_DOC_PARAM}=${encodeURIComponent(docId)}`;

    this.ydoc.on('update', this.handleDocUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);

    // The browser knows when the network came back before any timer does.
    window.addEventListener('online', this.handleOnline);

    this.connect();
  }

  private connect(): void {
    if (this.destroyed) return;

    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', this.handleOpen);
    socket.addEventListener('message', this.handleMessage);
    socket.addEventListener('close', this.handleClose);

    this.socket = socket;
  }

  private detachSocket(): void {
    if (!this.socket) return;

    this.socket.removeEventListener('open', this.handleOpen);
    this.socket.removeEventListener('message', this.handleMessage);
    this.socket.removeEventListener('close', this.handleClose);
    this.socket.close();
    this.socket = null;
  }

  destroy(): void {
    // Idempotent on purpose: React 19 StrictMode mounts, unmounts and mounts
    // again in development, and two live sockets would double every keystroke.
    if (this.destroyed) return;
    this.destroyed = true;

    // Before anything else: a pending retry that outlives the component is a
    // socket opening for a tab that is gone. connect() checks `destroyed` too.
    this.clearRetry();
    window.removeEventListener('online', this.handleOnline);

    this.ydoc.off('update', this.handleDocUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);

    this.detachSocket();

    // Before the doc: this detaches the store's own observers, and destroying
    // the document first can leave a write running against a destroyed Y.Doc.
    // Not awaited — destroy() is called from a React cleanup, which cannot. The
    // cost is that updates from the last moments before a tab closes may not
    // reach IndexedDB; the server already has them.
    void this.local.destroy();

    this.awareness.destroy();
    this.ydoc.destroy();
  }

  private setStatus(status: CollabStatus): void {
    this.status = status;
    this.onStatus?.();
  }

  private setReady(): void {
    if (this.ready || this.destroyed) return;
    this.ready = true;
    this.onStatus?.();
  }

  private clearRetry(): void {
    if (this.retry === null) return;
    clearTimeout(this.retry);
    this.retry = null;
  }

  private send(message: Uint8Array): void {
    // Not being connected is not an error, and there is nothing to queue: what
    // was typed is in the Y.Doc, and the next sync step 1 tells the server
    // exactly what it missed.
    const socket = this.socket;
    if (this.destroyed || socket === null || socket.readyState !== WebSocket.OPEN) return;

    // Copied into an ArrayBuffer-backed view: lib0 returns Uint8Array over an
    // ArrayBufferLike, which could in principle be a SharedArrayBuffer, and
    // WebSocket.send does not accept one. The messages are small.
    socket.send(new Uint8Array(message));
  }

  private sendSync(write: (encoder: encoding.Encoder) => void): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Sync);
    write(encoder);
    this.send(encoding.toUint8Array(encoder));
  }

  private readonly handleOpen = (): void => {
    // Our state vector, including everything typed while disconnected and
    // everything restored from IndexedDB — so the server replies with exactly
    // what we lack. This is the whole offline-sync mechanism, and the reason
    // there is no queue.
    this.sendSync((encoder) => syncProtocol.writeSyncStep1(encoder, this.ydoc));

    // The room forgot our presence when the socket died: without this a
    // reconnected user has live text and no caret. It also fixes a gap in the
    // first connection, where the constructor's setLocalState ran before the
    // socket was open and hit send()'s OPEN guard.
    this.awareness.setLocalState({ user: this.user });
  };

  private readonly handleOnline = (): void => {
    if (this.destroyed || this.status !== 'reconnecting') return;

    // The wait was for the network, and it is back. `attempt` is deliberately
    // not reset — only a real sync proves the server is there.
    this.clearRetry();
    this.detachSocket();
    this.connect();
  };

  private readonly handleMessage = (event: MessageEvent<ArrayBuffer>): void => {
    const decoder = decoding.createDecoder(new Uint8Array(event.data));

    switch (decoding.readVarUint(decoder)) {
      case MessageType.Sync: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MessageType.Sync);
        syncProtocol.readSyncMessage(decoder, encoder, this.ydoc, REMOTE);

        if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));

        // The first sync message carries the server's text, so this is the
        // moment the document is real for a file with no local copy yet — the
        // only way a never-before-opened file becomes ready.
        this.setReady();

        // Reset on a *successful sync*, never on 'open'. A server that accepts
        // the upgrade and then immediately closes — a crash loop, or a proxy in
        // front of a dead backend — would otherwise reset the backoff on every
        // attempt, which is a tight loop wearing a friendly name.
        this.attempt = 0;
        if (this.status !== 'synced') this.setStatus('synced');
        return;
      }

      case MessageType.Awareness:
        applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), REMOTE);
        return;

      default:
        return;
    }
  };

  private readonly handleClose = (event: CloseEvent): void => {
    if (this.destroyed) return;

    this.closeCode = event.code;
    this.closeReason = event.reason;

    // Checked before any timer is armed. Retrying one of these is a client
    // hammering a room it can never re-enter — the removed-user loop.
    if (isTerminalClose(event.code)) {
      this.setStatus('closed');
      return;
    }

    this.setStatus('reconnecting');

    const delay = backoffDelay(this.attempt);
    this.attempt += 1;

    this.clearRetry();
    this.retry = setTimeout(() => {
      this.retry = null;
      this.detachSocket();
      this.connect();
    }, delay);
  };

  private readonly handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE) return;
    this.sendSync((encoder) => syncProtocol.writeUpdate(encoder, update));
  };

  private readonly handleAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === REMOTE) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Awareness);
    encoding.writeVarUint8Array(
      encoder,
      encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]),
    );
    this.send(encoding.toUint8Array(encoder));
  };
}
