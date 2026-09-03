import { MessageType, WS_DOC_PARAM, WS_PATH, Y_TEXT_KEY } from '@collab/shared';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

/**
 * The smallest client that speaks the module 3.4 protocol correctly.
 *
 * Adapted from `connectYjs` in apps/server/test/helpers/ws.ts, which stays the
 * source of truth if the protocol ever changes. It is COPIED rather than
 * imported on purpose (Phase 8 decision I): that file is a Vitest fixture in
 * another workspace's test tree, exported through no barrel, and a load tool has
 * no business depending on the server's test internals.
 *
 * Two details are easy to get wrong from scratch and are load-bearing here:
 * the `origin === REMOTE` guard, without which every applied update is echoed
 * straight back and the run becomes a broadcast storm; and replying only when
 * the encoder holds more than the type byte.
 *
 * Awareness is deliberately NOT published. This client has no cursor, and fake
 * presence would inflate exactly the traffic module 8.2 is built to measure.
 * Inbound awareness is decoded far enough to be discarded, which is what the
 * server's relay expects of any peer.
 */

const REMOTE = 'remote';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

export interface LoadClient {
  readonly index: number;
  readonly docId: string;
  /** Resolves on open, rejects if the socket closes before opening. */
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;
  edit: () => void;
  editsSent: () => number;
  /** Inserts a latency marker instead of an ordinary character on this tick. */
  insertMarker: (marker: string) => void;
  /** Characters contributed as markers — markers are never removed (F1), so
   *  this is what makes the convergence expectation exact. */
  markerChars: () => number;
  /** Fires with INSERTED text only, never the whole document. */
  observeInserts: (listener: (inserted: string) => void) => void;
  text: () => string;
  closeCode: () => number;
  close: () => void;
  destroy: () => void;
}

/** http://host:4000 -> ws://host:4000/ws?doc=<docId> */
export function toWsUrl(server: string, docId: string): string {
  const url = new URL(server);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = WS_PATH;
  url.searchParams.set(WS_DOC_PARAM, docId);
  return url.toString();
}

export function connectClient(options: {
  index: number;
  server: string;
  docId: string;
  cookie: string;
}): LoadClient {
  const { index, docId } = options;

  const doc = new Y.Doc();
  const ytext = doc.getText(Y_TEXT_KEY);
  const socket = new WebSocket(toWsUrl(options.server, docId), {
    headers: { cookie: options.cookie },
  });

  let edits = 0;
  let markers = 0;
  let code = 0;
  let open = false;

  let settleOpened: (() => void) | undefined;
  let failOpened: ((error: Error) => void) | undefined;
  const opened = new Promise<void>((resolve, reject) => {
    settleOpened = resolve;
    failOpened = reject;
  });

  let settleClosed: ((value: number) => void) | undefined;
  const closed = new Promise<number>((resolve) => {
    settleClosed = resolve;
  });

  const send = (message: Uint8Array): void => {
    if (socket.readyState === socket.OPEN) socket.send(message);
  };

  const sync = (write: (encoder: encoding.Encoder) => void): void => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Sync);
    write(encoder);
    send(encoding.toUint8Array(encoder));
  };

  socket.on('open', () => {
    open = true;
    sync((encoder) => syncProtocol.writeSyncStep1(encoder, doc));
    settleOpened?.();
  });

  socket.on('message', (data: Buffer) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));

    switch (decoding.readVarUint(decoder)) {
      case MessageType.Sync: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MessageType.Sync);
        syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE);
        // > 1 means the encoder holds more than the type byte — a reply the peer
        // actually needs. Sending the bare byte would be a message per message,
        // forever.
        if (encoding.length(encoder) > 1) send(encoding.toUint8Array(encoder));
        return;
      }
      default:
        // Awareness, or anything else this client does not care about.
        return;
    }
  });

  socket.on('close', (closeCode: number) => {
    code = closeCode;
    if (!open) {
      failOpened?.(new Error(`client ${index} closed before opening (code ${closeCode})`));
    }
    settleClosed?.(closeCode);
  });

  socket.on('error', () => {
    // A refused upgrade surfaces here; `close` always follows and is what the
    // caller awaits. Swallowed so a rejected socket cannot crash the worker.
  });

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    sync((encoder) => syncProtocol.writeUpdate(encoder, update));
  });

  return {
    index,
    docId,
    opened,
    closed,
    edit: () => {
      const at = Math.floor(Math.random() * (ytext.length + 1));
      ytext.insert(at, ALPHABET.charAt(edits % ALPHABET.length));
      edits += 1;
    },
    editsSent: () => edits,
    insertMarker: (marker: string) => {
      // Appended rather than inserted at a random offset: one insert() call, so
      // it arrives as one delta and the observer sees it whole.
      ytext.insert(ytext.length, marker);
      markers += marker.length;
    },
    markerChars: () => markers,
    observeInserts: (listener) => {
      ytext.observe((event) => {
        for (const part of event.delta) {
          if (typeof part.insert === 'string') listener(part.insert);
        }
      });
    },
    text: () => ytext.toString(),
    closeCode: () => code,
    close: () => {
      if (code === 0) socket.close();
    },
    destroy: () => doc.destroy(),
  };
}

/** djb2. Comparing 200 full documents across thread boundaries would measure
 *  the harness rather than the server. */
export function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}
