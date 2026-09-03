import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';

import { Y_TEXT_KEY, makeDocId } from '@collab/shared';

import {
  flushAllRooms,
  joinRoom,
  leaveRoom,
  roomCount,
  type CollabConnection,
} from '../src/modules/collab/index.js';
import { deleteFile } from '../src/modules/files/service.js';
import { docStore } from '../src/modules/persistence/index.js';
import { deleteProject } from '../src/modules/projects/service.js';
import { createTestApp } from './helpers/app.js';
import { registerUser, type SignedInUser } from './helpers/auth.js';
import { prisma, resetDb } from './helpers/db.js';
import { createProject } from './helpers/projects.js';

/**
 * Module 3.3 — the registry on its own. No sockets: nothing in room.ts touches
 * one, and module 3.4 is what first hands it a real connection.
 */

let alice: SignedInUser;
let projectId: string;

/**
 * The registry is module-level state that outlives a single test, so every
 * connection handed out is tracked and released afterwards. Without this a test
 * that joins and never leaves keeps its room alive and the next test's
 * roomCount() is off by however many leaked.
 */
const handedOut: CollabConnection[] = [];

/** The registry only uses `doc` for identity and `conns` for the refcount, so a
 *  connection here is that plus a socket that is never called. */
function connectionFor(fileId: string, project = projectId): CollabConnection {
  const conn: CollabConnection = {
    socket: {} as WebSocket,
    user: { id: alice.user.id, email: alice.user.email, displayName: alice.user.displayName },
    doc: { projectId: project, fileId },
  };
  handedOut.push(conn);
  return conn;
}

async function createFile(path: string, content = '', isDir = false): Promise<string> {
  const file = await prisma.file.create({
    data: { projectId, path, content, isDir },
    select: { id: true },
  });
  return file.id;
}

beforeEach(async () => {
  await resetDb();
  alice = await registerUser(createTestApp());
  projectId = await createProject(alice.user.id);
});

afterEach(async () => {
  // Leaving a connection that never joined is a no-op, so this needs no
  // bookkeeping about which tests actually joined.
  for (const conn of handedOut) await leaveRoom(conn);
  handedOut.length = 0;
  expect(roomCount()).toBe(0);
});

describe('room registry', () => {
  it('shares one room between two connections to the same file', async () => {
    const fileId = await createFile('main.py');

    const first = await joinRoom(connectionFor(fileId));
    const second = await joinRoom(connectionFor(fileId));

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(roomCount()).toBe(1);
    expect(first?.conns.size).toBe(2);
  });

  it('gives different files different rooms', async () => {
    const a = await joinRoom(connectionFor(await createFile('a.py')));
    const b = await joinRoom(connectionFor(await createFile('b.py')));

    expect(a).not.toBe(b);
    expect(roomCount()).toBe(2);
  });

  it('seeds the document from File.content', async () => {
    const fileId = await createFile('main.py', 'hello');

    const room = await joinRoom(connectionFor(fileId));

    expect(room?.ydoc.getText(Y_TEXT_KEY).toString()).toBe('hello');
  });

  it('seeds once when two connections race a cold room', async () => {
    const fileId = await createFile('main.py', 'hello');

    // Deliberately not awaited in between: both calls run before either resolves,
    // which is the case that would otherwise create and seed two documents.
    const [first, second] = await Promise.all([
      joinRoom(connectionFor(fileId)),
      joinRoom(connectionFor(fileId)),
    ]);

    expect(second).toBe(first);
    expect(roomCount()).toBe(1);
    expect(first?.ydoc.getText(Y_TEXT_KEY).toString()).toBe('hello');
  });

  it('evicts only when the last connection leaves', async () => {
    const fileId = await createFile('main.py');
    const one = connectionFor(fileId);
    const two = connectionFor(fileId);

    await joinRoom(one);
    await joinRoom(two);

    await leaveRoom(one);
    expect(roomCount()).toBe(1);

    await leaveRoom(two);
    expect(roomCount()).toBe(0);
  });

  it('re-seeds from the database when a file is reopened after eviction', async () => {
    const fileId = await createFile('main.py', 'first');
    const conn = connectionFor(fileId);

    const before = await joinRoom(conn);
    await leaveRoom(conn);

    // A reopened file is a genuinely new room, re-read from the database — the
    // old one was destroyed. (What an *edited* document leaves behind for it to
    // read is module 3.3b's flush, covered below.)
    const after = await joinRoom(connectionFor(fileId));

    expect(after).not.toBe(before);
    expect(after?.ydoc.getText(Y_TEXT_KEY).toString()).toBe('first');
  });

  it('refuses a file that does not exist', async () => {
    expect(await joinRoom(connectionFor('cmea1x4k80001ab12gh78ij90'))).toBeNull();
    expect(roomCount()).toBe(0);
  });

  it('refuses a file id that belongs to another project', async () => {
    const fileId = await createFile('main.py');
    const other = await createProject(alice.user.id, 'Other project');

    expect(await joinRoom(connectionFor(fileId, other))).toBeNull();
  });

  it('refuses a directory', async () => {
    const dirId = await createFile('src', '', true);

    expect(await joinRoom(connectionFor(dirId))).toBeNull();
  });

  it('opens a file created after an earlier attempt failed', async () => {
    const fileId = 'cmea1x4k80002ab12kl12mn34';
    expect(await joinRoom(connectionFor(fileId))).toBeNull();

    // The miss must not be cached, or the row appearing later would be
    // unopenable until the server restarted.
    await prisma.file.create({ data: { id: fileId, projectId, path: 'late.py', content: 'late' } });

    const room = await joinRoom(connectionFor(fileId));
    expect(room?.ydoc.getText(Y_TEXT_KEY).toString()).toBe('late');
  });
});

/** Module 3.3b — interim durability, replaced by module 4.3. */
/**
 * Module 4.3 — the update log is the source of truth.
 *
 * This suite replaces module 3.3b's `flush to File.content`, which tested the
 * interim flush that 4.3 deletes. One of those cases asserted File.content stays
 * stale while a room is open; Phase 4 inverts that on purpose, and 4.4 is what
 * takes ownership of the field.
 */
describe('persistence', () => {
  function docIdOf(fileId: string): string {
    return makeDocId(projectId, fileId);
  }

  async function updateCount(fileId: string): Promise<number> {
    return docStore.countUpdates(docIdOf(fileId));
  }

  async function contentOf(fileId: string): Promise<string> {
    const file = await prisma.file.findUniqueOrThrow({
      where: { id: fileId },
      select: { content: true },
    });
    return file.content;
  }

  it('batches many edits into a single row', async () => {
    const fileId = await createFile('main.py');
    const conn = connectionFor(fileId);

    const room = await joinRoom(conn);
    for (let i = 0; i < 50; i += 1) room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'x');

    // Nothing is written per keystroke, and the seed did not become a log row.
    expect(await updateCount(fileId)).toBe(0);

    await room?.persistence.flush();
    expect(await updateCount(fileId)).toBe(1);
  });

  it('writes immediately once the size trigger is crossed', async () => {
    const fileId = await createFile('main.py');
    const conn = connectionFor(fileId);

    const room = await joinRoom(conn);

    // Over 64KB: this batch is taken right away, so the small edit after it
    // starts a fresh one and the flush below writes a second row, not one merged.
    room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'x'.repeat(70_000));
    room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'y');

    await room?.persistence.flush();

    expect(await updateCount(fileId)).toBe(2);
  });

  it('reloads an evicted document from the log', async () => {
    const fileId = await createFile('main.py');
    const conn = connectionFor(fileId);

    const room = await joinRoom(conn);
    room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'typed');
    await leaveRoom(conn);

    expect(roomCount()).toBe(0);
    expect(await updateCount(fileId)).toBe(1);

    const rejoined = await joinRoom(connectionFor(fileId));
    expect(rejoined?.ydoc.getText(Y_TEXT_KEY).toString()).toBe('typed');
  });

  it('seeds from File.content exactly once in a document’s life', async () => {
    const fileId = await createFile('main.py', 'hello');

    const first = connectionFor(fileId);
    expect((await joinRoom(first))?.ydoc.getText(Y_TEXT_KEY).toString()).toBe('hello');
    await leaveRoom(first);

    // The seed was persisted, so the fallback cannot run a second time.
    expect(await prisma.docSnapshot.count({ where: { docId: docIdOf(fileId) } })).toBe(1);

    const second = connectionFor(fileId);
    const room = await joinRoom(second);

    // Not 'hellohello': re-seeding on top of the stored state is the failure
    // this whole ordering exists to prevent.
    expect(room?.ydoc.getText(Y_TEXT_KEY).toString()).toBe('hello');
  });

  it('does not grow the log when a document is reopened', async () => {
    const fileId = await createFile('main.py', 'seed');

    const first = connectionFor(fileId);
    const room = await joinRoom(first);
    room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'x');
    await leaveRoom(first);

    const after = await updateCount(fileId);
    expect(after).toBe(1);

    // Loading applies updates, which fires ydoc.on('update'). If the buffer were
    // attached before the load, each open would append everything it just read.
    for (let i = 0; i < 2; i += 1) {
      const conn = connectionFor(fileId);
      await joinRoom(conn);
      await leaveRoom(conn);
    }

    expect(await updateCount(fileId)).toBe(after);
  });

  it('materializes File.content on flush', async () => {
    const fileId = await createFile('main.py', 'first');
    const conn = connectionFor(fileId);

    const room = await joinRoom(conn);
    room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'edited ');
    await room?.persistence.flush();

    expect(await contentOf(fileId)).toBe('edited first');
  });

  it('materializes on eviction and on flushAllRooms', async () => {
    const evicted = await createFile('a.py', 'first');
    const live = await createFile('b.py', 'first');

    const conn = connectionFor(evicted);
    (await joinRoom(conn))?.ydoc.getText(Y_TEXT_KEY).insert(0, 'edited ');
    await leaveRoom(conn);
    expect(await contentOf(evicted)).toBe('edited first');

    const open = connectionFor(live);
    (await joinRoom(open))?.ydoc.getText(Y_TEXT_KEY).insert(0, 'edited ');
    await flushAllRooms();
    expect(await contentOf(live)).toBe('edited first');
  });

  it('keeps the append when materializing fails', async () => {
    const fileId = await createFile('main.py', 'first');
    const conn = connectionFor(fileId);

    const room = await joinRoom(conn);
    room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'edited ');

    const failing = vi
      .spyOn(prisma.file, 'updateMany')
      .mockRejectedValueOnce(new Error('materialize boom'));

    // Derived text must never take real edits down with it.
    await expect(room?.persistence.flush()).resolves.toBeUndefined();
    failing.mockRestore();

    expect(await updateCount(fileId)).toBe(1);
    expect(await contentOf(fileId)).toBe('first');

    await leaveRoom(conn);
    const rejoined = await joinRoom(connectionFor(fileId));
    expect(rejoined?.ydoc.getText(Y_TEXT_KEY).toString()).toBe('edited first');
  });

  it('compacts the log once it grows past the threshold', async () => {
    const fileId = await createFile('main.py');
    const conn = connectionFor(fileId);
    const room = await joinRoom(conn);

    // One row per flush, so this walks the log past COMPACT_AFTER (200).
    for (let i = 0; i < 201; i += 1) {
      room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'x');
      await room?.persistence.flush();
    }

    // Nothing folded yet: module 11.1 will not fold a row younger than
    // COMPACT_LAG_MS (30s), and every row above was written milliseconds ago.
    expect(await updateCount(fileId)).toBe(201);

    // Backdate them, the way real rows are long committed by the time a
    // document has accumulated two hundred flushes.
    await prisma.docUpdate.updateMany({
      where: { docId: docIdOf(fileId) },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'x');
    await room?.persistence.flush();

    // The aged rows folded into the snapshot and are gone. The row this last
    // flush just appended is inside the margin, so it is deliberately left.
    expect(await updateCount(fileId)).toBe(1);

    await leaveRoom(conn);
    const rejoined = await joinRoom(connectionFor(fileId));
    expect(rejoined?.ydoc.getText(Y_TEXT_KEY).toString()).toBe('x'.repeat(202));
  });

  it('folds updates this instance never saw', async () => {
    const fileId = await createFile('main.py');
    const conn = connectionFor(fileId);
    const room = await joinRoom(conn);

    // A second server instance's write: a Y.Doc this process holds no handle
    // on, appended straight to the shared log. The doc bus is at-most-once
    // (ADR-003), so this is precisely the row that never arrives — room.ydoc
    // will not contain it at any point in this test.
    const elsewhere = new Y.Doc();
    elsewhere.getText(Y_TEXT_KEY).insert(0, 'remote');
    await docStore.appendUpdate(docIdOf(fileId), Y.encodeStateAsUpdate(elsewhere));

    for (let i = 0; i < 201; i += 1) {
      room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'x');
      await room?.persistence.flush();
    }

    expect(room?.ydoc.getText(Y_TEXT_KEY).toString()).not.toContain('remote');

    await prisma.docUpdate.updateMany({
      where: { docId: docIdOf(fileId) },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    // Crosses the threshold with every earlier row — the remote one included —
    // inside the fold boundary, and therefore about to be deleted.
    room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'x');
    await room?.persistence.flush();
    expect(await updateCount(fileId)).toBe(1);

    await leaveRoom(conn);
    const rejoined = await joinRoom(connectionFor(fileId));
    const text = rejoined!.ydoc.getText(Y_TEXT_KEY).toString();

    // Race B. Snapshotting room.ydoc would have lost this permanently: the row
    // holding it is deleted, and this process's document never held it.
    expect(text).toContain('remote');
    expect(text).toHaveLength(202 + 'remote'.length);
  });

  it('does not write File.content when compacting', async () => {
    const fileId = await createFile('main.py', 'first');
    const conn = connectionFor(fileId);

    const room = await joinRoom(conn);
    room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'edited ');
    await room?.persistence.flush();

    const before = await prisma.file.findUniqueOrThrow({
      where: { id: fileId },
      select: { updatedAt: true },
    });

    // Compaction rewrites how the state is stored, not the state. The seed
    // snapshot left the watermark at 0n, which is the CAS token here.
    await docStore.compact(docIdOf(fileId), Y.encodeStateAsUpdate(room!.ydoc), 1n, 0n);

    const after = await prisma.file.findUniqueOrThrow({
      where: { id: fileId },
      select: { updatedAt: true },
    });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('drops a deleted file’s doc rows', async () => {
    const fileId = await createFile('main.py', 'first');
    const conn = connectionFor(fileId);

    const room = await joinRoom(conn);
    room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'edited ');
    await leaveRoom(conn);
    expect(await updateCount(fileId)).toBe(1);

    await deleteFile(projectId, fileId);

    expect(await updateCount(fileId)).toBe(0);
    expect(await prisma.docSnapshot.count({ where: { docId: docIdOf(fileId) } })).toBe(0);
  });

  it('drops the doc rows of every file in a deleted project', async () => {
    const fileId = await createFile('main.py', 'first');
    const conn = connectionFor(fileId);

    const room = await joinRoom(conn);
    room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'edited ');
    await leaveRoom(conn);

    await deleteProject(projectId);

    expect(await updateCount(fileId)).toBe(0);
    expect(await prisma.docSnapshot.count({ where: { docId: docIdOf(fileId) } })).toBe(0);
  });

  it('makes a rejoin wait for the write already in flight', async () => {
    const fileId = await createFile('main.py', 'first');
    const conn = connectionFor(fileId);

    const room = await joinRoom(conn);
    room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'edited ');

    // Deliberately not awaited: this is the refresh case, where the reconnect
    // arrives while the write is still in flight.
    const leaving = leaveRoom(conn);
    const rejoined = await joinRoom(connectionFor(fileId));
    await leaving;

    expect(rejoined?.ydoc.getText(Y_TEXT_KEY).toString()).toBe('edited first');
  });

  it('still evicts when the file row is gone', async () => {
    const fileId = await createFile('main.py', 'first');
    const conn = connectionFor(fileId);

    const room = await joinRoom(conn);
    room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'edited ');
    await prisma.file.delete({ where: { id: fileId } });

    await expect(leaveRoom(conn)).resolves.toBeUndefined();
    expect(roomCount()).toBe(0);
  });

  it('flushAllRooms writes a live room without evicting it', async () => {
    const fileId = await createFile('main.py', 'first');
    const conn = connectionFor(fileId);

    const room = await joinRoom(conn);
    room?.ydoc.getText(Y_TEXT_KEY).insert(0, 'edited ');

    await flushAllRooms();

    expect(await updateCount(fileId)).toBe(1);
    expect(roomCount()).toBe(1);
    expect(room?.conns.size).toBe(1);
  });
});
