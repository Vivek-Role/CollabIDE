import { Y_TEXT_KEY, makeDocId } from '@collab/shared';
import type { DocRef } from '@collab/shared';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { prisma } from '../../db.js';
import { attachPersistence, docStore, type DocPersistence } from '../persistence/index.js';
import { unsubscribeDoc } from '../redis/index.js';
import type { CollabConnection } from './wsServer.js';

/**
 * One document per open file, shared by everyone editing it.
 *
 * A room is created when the first connection joins, loaded from the update log
 * (module 4.3), and destroyed when the last one leaves. Module 3.4 wires it into
 * the handshake **after** checking project membership, so that "authorize before
 * attach" stays literally true.
 *
 * The room owns its Y.Doc and Awareness outright — created here, destroyed here,
 * never handed in from outside. Module 3.4 reads them and applies updates; it
 * never swaps them.
 */

export interface Room {
  docId: string;
  ref: DocRef;
  ydoc: Y.Doc;
  awareness: Awareness;
  /** The reference count *is* this set's size — there is no second counter to
   *  drift from it. */
  conns: Set<CollabConnection>;
  /** The write buffer for this document's updates. Attached at creation, after
   *  loading; flushed and detached at eviction (module 4.3). */
  persistence: DocPersistence;
  /** Whether module 3.4's fan-out observers are attached. A flag rather than a
   *  connection count, because two sockets can join before either resumes. */
  observed: boolean;
}

/**
 * Promises, not rooms.
 *
 * Seeding awaits Prisma, and a second connection can arrive during that await.
 * The promise is stored **synchronously**, before the await, so the second
 * joiner waits on the same one instead of creating and seeding a second copy of
 * the document — which would show up as the file's text appearing twice.
 */
const rooms = new Map<string, Promise<Room | null>>();

/**
 * Writes that have started but not finished.
 *
 * A room is removed from the map before its last updates are appended, so a
 * rejoin — pressing F5 is exactly this — could otherwise call docStore.load()
 * and miss them, leaving the live room short of the user's final edits for the
 * rest of the session. Creating a room waits here first.
 */
const pendingWrites = new Map<string, Promise<void>>();

/** Null for a file that does not exist, belongs to another project, or is a
 *  directory. Module 3.4 turns that into CloseCode.NotFound. */
async function createRoom(ref: DocRef): Promise<Room | null> {
  const docId = makeDocId(ref.projectId, ref.fileId);

  // The previous room for this document may still be writing. Loading before
  // that lands would build a room missing its final updates.
  const inFlight = pendingWrites.get(docId);
  if (inFlight) await inFlight;

  const file = await prisma.file.findFirst({
    // The projectId half of the doc id is never trusted on its own: the row must
    // belong to that project for this to return anything.
    where: { id: ref.fileId, projectId: ref.projectId },
    select: { content: true, isDir: true },
  });

  if (!file || file.isDir) return null;

  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);

  // A new Awareness gives itself an empty local state, which would then be
  // relayed to every client as a phantom cursor belonging to the server. The
  // server relays presence; it never has any.
  awareness.setLocalState(null);

  const loaded = await docStore.load(docId);

  if (loaded.exists) {
    if (loaded.snapshot) Y.applyUpdate(ydoc, loaded.snapshot);
    for (const update of loaded.updates) Y.applyUpdate(ydoc, update);
  } else {
    // First time this document has ever been opened: File.content is the only
    // text that exists for it. Seed once...
    if (file.content.length > 0) {
      Y.transact(ydoc, () => {
        ydoc.getText(Y_TEXT_KEY).insert(0, file.content);
      });
    }

    // ...and persist that seed immediately, before anything can be typed. The
    // insert above happens before the buffer is attached, so it produces no log
    // row; without this snapshot the next open would find nothing stored, seed
    // from File.content again and replay the log on top of it — the file's text
    // appearing twice.
    await docStore.writeSnapshot(docId, Y.encodeStateAsUpdate(ydoc), 0n);
  }

  // LAST, and never earlier. applyUpdate fires ydoc.on('update'), so attaching
  // the buffer before the load above would append every update just read out of
  // the log straight back into it — the log doubling on every open, while the
  // room still looks perfectly correct.
  const persistence = attachPersistence({ docId, fileId: ref.fileId, ydoc, store: docStore });

  return {
    docId,
    ref,
    ydoc,
    awareness,
    conns: new Set(),
    persistence,
    observed: false,
  };
}

export async function joinRoom(conn: CollabConnection): Promise<Room | null> {
  const docId = makeDocId(conn.doc.projectId, conn.doc.fileId);

  let pending = rooms.get(docId);
  if (!pending) {
    pending = createRoom(conn.doc);
    rooms.set(docId, pending);
  }

  const room = await pending;

  if (!room) {
    // Do not cache the miss: the file may be created a moment from now, and a
    // permanently unopenable doc id would be a strange thing to have to restart
    // the server to fix.
    if (rooms.get(docId) === pending) rooms.delete(docId);
    return null;
  }

  // The room we awaited may have been evicted while we were waiting — someone
  // else joined it, left again, and took the refcount to zero. Its Y.Doc is
  // destroyed, so start over rather than attach to it.
  if (rooms.get(docId) !== pending) return joinRoom(conn);

  room.conns.add(conn);
  return room;
}

export async function leaveRoom(conn: CollabConnection): Promise<void> {
  const docId = makeDocId(conn.doc.projectId, conn.doc.fileId);

  const pending = rooms.get(docId);
  if (!pending) return;

  const room = await pending;
  if (!room) return;

  room.conns.delete(conn);
  if (room.conns.size > 0) return;

  // Remove it from the map *before* tearing it down, so anyone arriving in the
  // meantime builds a fresh room instead of joining a dying one.
  if (rooms.get(docId) === pending) rooms.delete(docId);

  // Drop the doc-bus subscription HERE — synchronously, before the flush below
  // is awaited (module 7.1). That await can take a while, and a connection
  // arriving inside it builds a fresh room that subscribes for this same docId;
  // unsubscribing afterwards would tear down the *new* room's subscription and
  // that document would silently stop receiving remote edits for the rest of its
  // life. Everything from the map removal to here is synchronous, so nothing can
  // slip in between. It is also what guarantees no remote frame can arrive after
  // ydoc.destroy() below. A no-op if this room never subscribed.
  unsubscribeDoc(docId);

  // Register the write before yielding — everything from the map removal to here
  // is synchronous, so a rejoin cannot slip in between and miss it.
  const write = room.persistence
    .flush()
    .catch((error: unknown) => {
      // A failed write must not wedge the room: it is already out of the map.
      console.error(`[collab] final write failed for ${docId}`, error);
    })
    .finally(() => {
      if (pendingWrites.get(docId) === write) pendingWrites.delete(docId);
    });

  pendingWrites.set(docId, write);
  await write;

  // Only now: detaching or destroying first would strand anything a retry inside
  // the buffer still needs.
  room.persistence.detach();
  room.awareness.destroy();
  room.ydoc.destroy();
}

/**
 * Writes every live room's buffered updates, without evicting anything.
 *
 * Called from shutdown, where the process is going away and destroying rooms
 * would buy nothing. allSettled so one failing write does not abandon the rest.
 */
export async function flushAllRooms(): Promise<void> {
  await Promise.allSettled(
    [...rooms.values()].map(async (pending) => {
      const room = await pending;
      if (!room) return;

      try {
        await room.persistence.flush();
      } catch (error) {
        console.error(`[collab] flush failed for ${room.docId}`, error);
      }
    }),
  );
}

/** Live rooms, including ones still being seeded. Tests and diagnostics only. */
export function roomCount(): number {
  return rooms.size;
}

/** Every open document, for module 3.4b's disconnect hooks. Awaits rooms that
 *  are still being seeded, so a document opened a millisecond ago is included. */
export async function allRooms(): Promise<Room[]> {
  const resolved = await Promise.all([...rooms.values()]);
  return resolved.filter((room): room is Room => room !== null);
}
