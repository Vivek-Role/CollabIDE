import { CloseCode, MessageType, closeReason } from '@collab/shared';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { config } from '../../config.js';
import { AppError } from '../../http/errors.js';
import { assertProjectAccess, hasRole } from '../auth/index.js';
import { DocFrameKind, publishDoc, subscribeDoc, type DocFrame } from '../redis/index.js';
import { allRooms, joinRoom, leaveRoom, type Room } from './room.js';
import type { CollabConnection } from './wsServer.js';

/**
 * The collaboration protocol: who may join a document, and what the sockets in
 * a room say to each other.
 *
 * Yjs does the merging. This file does transport, authorization and fan-out —
 * the parts a bundled y-websocket server would hide (ADR-001).
 *
 * Authorization happens **before** the socket is attached to a room, and it is
 * checked once, at join. A membership check per keystroke would be a database
 * read per keystroke; module 3.4b is what closes that window instead, by
 * disconnecting a user whose role changes.
 */

function reject(conn: CollabConnection, code: CloseCode): void {
  conn.socket.close(code, closeReason(code));
}

function send(conn: CollabConnection, message: Uint8Array): void {
  // readyState is checked because a broadcast can race a socket that is already
  // closing; ws throws on a send to a closed socket.
  if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(message);
}

function broadcast(room: Room, message: Uint8Array, origin: unknown): void {
  for (const peer of room.conns) {
    // Never echo an update back to the connection it came from: that is what
    // turns fast typing into duplicated text.
    if (peer === origin) continue;
    send(peer, message);
  }
}

function syncMessage(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Sync);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

/** Wraps an already-encoded awareness payload in the WebSocket frame. It takes
 *  the payload rather than the client list because module 7.1 sends the same
 *  bytes two ways — to local sockets, and to the doc bus — and encoding them
 *  twice would be pure waste. */
function awarenessMessage(payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Awareness);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

/**
 * The origin stamped on everything that arrives from another instance.
 *
 * It does two jobs. The observers below refuse to re-publish anything carrying
 * it, which is what stops two instances echoing a single keystroke back and
 * forth forever. And `isConnection` is false for it, so a remote peer's
 * awareness ids are never filed under one of *our* sockets — they belong to a
 * socket on the other instance, and only that instance may remove them.
 *
 * A private sentinel object, so nothing outside this file can forge it.
 */
const BUS_ORIGIN = { docBus: true };

/**
 * A frame from another instance, applied to the local document.
 *
 * Applying fires the observers below with BUS_ORIGIN, which fans the change out
 * to this instance's sockets and skips the publish. That is why there is no
 * separate "send this remote update to my clients" path — one code route serves
 * both sources.
 */
function applyRemoteFrame(room: Room, frame: DocFrame): void {
  try {
    if (frame.kind === DocFrameKind.Sync) {
      Y.applyUpdate(room.ydoc, frame.payload, BUS_ORIGIN);
    } else {
      applyAwarenessUpdate(room.awareness, frame.payload, BUS_ORIGIN);
    }
  } catch (error) {
    // A malformed or late frame — the room may be mid-eviction — must never
    // take the process down. The subscription is dropped before the doc is
    // destroyed, so this is a backstop rather than an expected path.
    console.error(`[collab] dropped a bus frame for ${room.docId}`, error);
  }
}

/**
 * One pair of observers per room, attached by whichever connection gets there
 * first and guarded by a flag on the room.
 *
 * The flag matters: `conns.size === 1` looks like the same test and is not.
 * joinRoom adds the connection *inside* the async function, so two sockets
 * joining the same cold room both complete their adds before either caller
 * resumes — and both then see a size of 2, leaving the room with no observers
 * and no fan-out at all. Check-and-set here has no await between the two halves.
 *
 * No unregistration is needed: eviction destroys the Y.Doc and the Awareness,
 * which drops their listeners, and a reopened file is a brand new room.
 *
 * **Module 7.1 added the doc bus beside the two broadcasts** — local fan-out
 * first, then a publish, so a local peer's latency never depends on Redis. The
 * subscription lives here rather than in room.ts for three reasons: this is
 * already the exactly-once-per-room site with a guard that is already correct,
 * room.ts importing this file would be a cycle, and the apply callback needs a
 * Room, which the bus must never learn about.
 */
function attachRoomObservers(room: Room): void {
  if (room.observed) return;
  room.observed = true;

  if (config.docBusEnabled) {
    subscribeDoc(room.docId, (frame) => applyRemoteFrame(room, frame));
  }

  room.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    broadcast(room, syncMessage((encoder) => syncProtocol.writeUpdate(encoder, update)), origin);

    // Never re-publish what the bus just handed us: that is the loop.
    if (origin !== BUS_ORIGIN && config.docBusEnabled) {
      publishDoc(room.docId, { kind: DocFrameKind.Sync, payload: update });
    }
  });

  room.awareness.on(
    'update',
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const changed = [...added, ...updated, ...removed];

      // Remember which awareness client ids belong to which socket, so its
      // cursor can be removed the instant it disconnects. False for BUS_ORIGIN,
      // which is what keeps a remote peer's ids off our sockets.
      if (isConnection(origin)) {
        for (const id of [...added, ...updated]) origin.awarenessIds.add(id);
        for (const id of removed) origin.awarenessIds.delete(id);
      }

      const payload = encodeAwarenessUpdate(room.awareness, changed);
      broadcast(room, awarenessMessage(payload), origin);

      if (origin !== BUS_ORIGIN && config.docBusEnabled) {
        publishDoc(room.docId, { kind: DocFrameKind.Awareness, payload });
      }
    },
  );
}

function isConnection(value: unknown): value is CollabConnection {
  return typeof value === 'object' && value !== null && 'awarenessIds' in value;
}

/** True only for a sync step 1, which is a *read* request — the one sync message
 *  a VIEWER is allowed to send. Peeked on a throwaway decoder so the real one is
 *  still untouched when readSyncMessage gets it. */
function isSyncStep1(data: Uint8Array): boolean {
  const peek = decoding.createDecoder(data);
  decoding.readVarUint(peek); // the message type, already known
  return decoding.readVarUint(peek) === syncProtocol.messageYjsSyncStep1;
}

function handleMessage(room: Room, conn: CollabConnection, data: Uint8Array): void {
  try {
    const decoder = decoding.createDecoder(data);

    switch (decoding.readVarUint(decoder)) {
      case MessageType.Sync: {
        // The enforcement that makes read-only real. The UI also disables the
        // editor, but that is a courtesy; this is the control.
        if (!conn.canWrite && !isSyncStep1(data)) {
          console.warn(`[collab] dropped a write from ${conn.user.email} (${conn.role})`);
          return;
        }

        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MessageType.Sync);
        syncProtocol.readSyncMessage(decoder, encoder, room.ydoc, conn);

        // Longer than the type byte means the protocol produced a reply.
        if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder));
        return;
      }

      case MessageType.Awareness: {
        applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn);
        return;
      }

      default:
        reject(conn, CloseCode.BadRequest);
    }
  } catch {
    // A malformed frame closes one socket. It must never take the process down.
    reject(conn, CloseCode.BadRequest);
  }
}

/**
 * @param early messages that arrived during the handshake, collected by
 * wsServer so the client's first sync step 1 is not lost.
 */
export async function handleConnection(
  conn: CollabConnection,
  early: Uint8Array[] = [],
): Promise<void> {
  // More can arrive while the awaits below run, for the same reason.
  const queued: Uint8Array[] = [...early];
  let room: Room | null = null;

  conn.socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      reject(conn, CloseCode.BadRequest);
      return;
    }

    const bytes = new Uint8Array(data);
    if (room) handleMessage(room, conn, bytes);
    else queued.push(bytes);
  });

  try {
    const access = await assertProjectAccess(conn.user.id, conn.doc.projectId, 'VIEWER');
    conn.role = access.role;
    conn.canWrite = hasRole(access.role, 'EDITOR');
  } catch (error) {
    // 404 for a non-member, exactly as the REST side answers, so project
    // existence stays private. 403 is reserved for a future minimum above VIEWER.
    const forbidden = error instanceof AppError && error.status === 403;
    reject(conn, forbidden ? CloseCode.Forbidden : CloseCode.NotFound);
    return;
  }

  const joined = await joinRoom(conn);
  if (!joined) {
    reject(conn, CloseCode.NotFound);
    return;
  }

  attachRoomObservers(joined);

  conn.socket.on('close', () => {
    // Take the cursor away first, then release the room — module 3.3b flushes
    // the text if this was the last connection.
    removeAwarenessStates(joined.awareness, [...conn.awarenessIds], null);
    void leaveRoom(conn);
  });

  // Start the handshake Yjs expects: our state vector, then whatever presence
  // the room already has.
  send(conn, syncMessage((encoder) => syncProtocol.writeSyncStep1(encoder, joined.ydoc)));

  const states = [...joined.awareness.getStates().keys()];
  if (states.length > 0) {
    send(conn, awarenessMessage(encodeAwarenessUpdate(joined.awareness, states)));
  }

  room = joined;
  for (const message of queued) handleMessage(joined, conn, message);
  queued.length = 0;
}

// ── module 3.4b: sockets whose access has just changed ──────────────────────
//
// A socket is authorized once, at join, and then lives for hours. These are how
// the code that *edits* membership or deletes a file tells the collaboration
// layer to drop the sockets it has just invalidated. Every one of them is called
// after the database change commits, so a client that reconnects immediately
// sees the new state.
//
// Closing is all that is needed: the `close` handler above removes the cursor
// and releases the room, and module 3.3b flushes the text if that was the last
// connection — which is what a demoted user's work deserves.

/** Both directions of a role change, and removal. A promoted VIEWER also has to
 *  reconnect: its open socket still carries `canWrite: false`. */
export async function disconnectProjectUser(projectId: string, userId: string): Promise<void> {
  for (const room of await allRooms()) {
    if (room.ref.projectId !== projectId) continue;

    for (const conn of [...room.conns]) {
      if (conn.user.id === userId) reject(conn, CloseCode.Gone);
    }
  }
}

export async function disconnectProject(projectId: string): Promise<void> {
  for (const room of await allRooms()) {
    if (room.ref.projectId !== projectId) continue;

    for (const conn of [...room.conns]) reject(conn, CloseCode.Gone);
  }
}

/** Deleting a file, or a directory and everything under it. */
export async function closeFileRooms(fileIds: string[]): Promise<void> {
  const doomed = new Set(fileIds);

  for (const room of await allRooms()) {
    if (!doomed.has(room.ref.fileId)) continue;

    for (const conn of [...room.conns]) reject(conn, CloseCode.Gone);
  }
}
