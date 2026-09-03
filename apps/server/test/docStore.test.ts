import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { docStore } from '../src/modules/persistence/index.js';
import { prisma, resetDb } from './helpers/db.js';

/**
 * Module 4.2 — the store on its own, against the real database.
 *
 * No rooms and no sockets: docId is an opaque string with no foreign key, so
 * these tests need neither a user nor a project. `yjs` appears here and not in
 * the implementation, which is the point — the store never interprets bytes.
 *
 * resetDb() truncates with `restart identity`, so DocUpdate ids restart at 1 in
 * every test. Nothing below asserts an absolute id.
 */

const DOC_A = 'projectA:fileA';
const DOC_B = 'projectB:fileB';

const TEXT = 'content';

/** A doc plus the individual updates it emitted, so a test can append a real
 *  sequence rather than one encoded state. */
function recordingDoc(): { doc: Y.Doc; updates: Uint8Array[] } {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  return { doc, updates };
}

/**
 * Backdates every row of a document past the compaction safety margin.
 *
 * `readForCompaction`'s cutoff is wall-clock, and nothing a test writes is ever
 * thirty seconds old. Moving `createdAt` is how a test says "these rows are
 * long committed" without sleeping.
 */
async function age(docId: string): Promise<void> {
  await prisma.docUpdate.updateMany({
    where: { docId },
    data: { createdAt: new Date(Date.now() - 60_000) },
  });
}

/**
 * The cutoff a real compactor passes — COMPACT_LAG_MS behind now.
 *
 * `new Date()` would be wrong here and quietly so: a row written a millisecond
 * ago is still older than "now", so every fresh row would come back eligible
 * and the margin would test nothing.
 */
function cutoff(): Date {
  return new Date(Date.now() - 30_000);
}

/** Everything is eligible: what the store returns when nothing is in flight. */
const PAST_EVERYTHING = new Date(Date.now() + 60_000);

function applyAll(loaded: { snapshot: Uint8Array | null; updates: Uint8Array[] }): Y.Doc {
  const doc = new Y.Doc();
  if (loaded.snapshot) Y.applyUpdate(doc, loaded.snapshot);
  for (const update of loaded.updates) Y.applyUpdate(doc, update);
  return doc;
}

beforeEach(async () => {
  await resetDb();
});

describe('load', () => {
  it('reports a document that has never been persisted', async () => {
    const loaded = await docStore.load('nope:nope');

    expect(loaded).toEqual({
      exists: false,
      snapshot: null,
      updates: [],
      lastUpdateId: null,
    });
  });

  it('round-trips a Y.Doc through the database', async () => {
    const doc = new Y.Doc();
    doc.getText(TEXT).insert(0, 'hello world');

    await docStore.appendUpdate(DOC_A, Y.encodeStateAsUpdate(doc));

    const loaded = await docStore.load(DOC_A);
    expect(loaded.exists).toBe(true);

    // A genuinely fresh document, built only from what the store returned.
    expect(applyAll(loaded).getText(TEXT).toString()).toBe('hello world');
  });

  it('returns the tail in id order, and only this document’s updates', async () => {
    const { doc, updates } = recordingDoc();
    doc.getText(TEXT).insert(0, 'a');
    doc.getText(TEXT).insert(1, 'b');
    doc.getText(TEXT).insert(2, 'c');
    expect(updates).toHaveLength(3);

    // Interleaved with another document, so a missing `where` would show up.
    const ids: bigint[] = [];
    for (const update of updates) {
      ids.push(await docStore.appendUpdate(DOC_A, update));
      await docStore.appendUpdate(DOC_B, new Uint8Array([9]));
    }

    const loaded = await docStore.load(DOC_A);

    expect(loaded.updates).toHaveLength(3);
    expect(loaded.lastUpdateId).toBe(ids.at(-1));
    expect(ids[0]! < ids[1]!).toBe(true);
    expect(ids[1]! < ids[2]!).toBe(true);
    expect(applyAll(loaded).getText(TEXT).toString()).toBe('abc');
  });

  it('stores bytes exactly, without interpreting them', async () => {
    // Not a valid Yjs update, deliberately: the store must not care.
    const pattern = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff, 0x00]);

    await docStore.appendUpdate(DOC_A, pattern);
    const loaded = await docStore.load(DOC_A);

    expect(loaded.updates[0]).toHaveLength(pattern.length);
    expect(Array.from(loaded.updates[0]!)).toEqual(Array.from(pattern));
  });

  it('returns the snapshot and only the updates appended after it', async () => {
    const { doc, updates } = recordingDoc();
    doc.getText(TEXT).insert(0, 'a');
    doc.getText(TEXT).insert(1, 'b');
    doc.getText(TEXT).insert(2, 'c');

    const first = await docStore.appendUpdate(DOC_A, updates[0]!);
    await docStore.appendUpdate(DOC_A, updates[1]!);
    const last = await docStore.appendUpdate(DOC_A, updates[2]!);

    // A snapshot folding in only the first update.
    const folded = new Y.Doc();
    Y.applyUpdate(folded, updates[0]!);
    await docStore.writeSnapshot(DOC_A, Y.encodeStateAsUpdate(folded), first);

    const loaded = await docStore.load(DOC_A);

    expect(loaded.snapshot).not.toBeNull();
    expect(loaded.updates).toHaveLength(2);
    expect(loaded.lastUpdateId).toBe(last);
    expect(applyAll(loaded).getText(TEXT).toString()).toBe('abc');
  });

  it('distinguishes persisted-but-empty from never persisted', async () => {
    await docStore.writeSnapshot(DOC_A, Y.encodeStateAsUpdate(new Y.Doc()), 0n);

    const loaded = await docStore.load(DOC_A);

    expect(loaded.exists).toBe(true);
    expect(loaded.updates).toEqual([]);
    expect(loaded.lastUpdateId).toBe(0n);
    expect(applyAll(loaded).getText(TEXT).toString()).toBe('');
  });
});

describe('writeSnapshot', () => {
  it('replaces the snapshot in place and deletes no updates', async () => {
    const doc = new Y.Doc();
    doc.getText(TEXT).insert(0, 'kept');
    await docStore.appendUpdate(DOC_A, Y.encodeStateAsUpdate(doc));

    await docStore.writeSnapshot(DOC_A, new Uint8Array([1]), 0n);
    await docStore.writeSnapshot(DOC_A, new Uint8Array([2, 2]), 5n);

    const rows = await prisma.docSnapshot.findMany({ where: { docId: DOC_A } });
    expect(rows).toHaveLength(1);
    expect(Array.from(rows[0]!.snapshot)).toEqual([2, 2]);
    expect(rows[0]!.updateId).toBe(5n);

    // The log is untouched by snapshotting: deleting superseded rows is 4.4's
    // transaction, not this method's business.
    expect(await docStore.countUpdates(DOC_A)).toBe(1);
  });
});

describe('compact', () => {
  it('folds the log into the snapshot and deletes what it covers', async () => {
    const { doc, updates } = recordingDoc();
    doc.getText(TEXT).insert(0, 'a');
    doc.getText(TEXT).insert(1, 'b');

    let last = 0n;
    for (const update of updates) last = await docStore.appendUpdate(DOC_A, update);
    await docStore.appendUpdate(DOC_B, new Uint8Array([9]));

    // No snapshot yet, so there is nothing to compare against.
    expect(await docStore.compact(DOC_A, Y.encodeStateAsUpdate(doc), last, null)).toBe(true);

    expect(await docStore.countUpdates(DOC_A)).toBe(0);
    expect(applyAll(await docStore.load(DOC_A)).getText(TEXT).toString()).toBe('ab');

    // The neighbouring document's log is untouched.
    expect(await docStore.countUpdates(DOC_B)).toBe(1);
  });

  it('keeps updates appended after the snapshot it folded', async () => {
    const { doc, updates } = recordingDoc();
    doc.getText(TEXT).insert(0, 'a');
    const folded = await docStore.appendUpdate(DOC_A, updates[0]!);

    // Snapshot the state as of the first update only, then carry on typing.
    const atFirst = new Y.Doc();
    Y.applyUpdate(atFirst, updates[0]!);

    doc.getText(TEXT).insert(1, 'b');
    await docStore.appendUpdate(DOC_A, updates[1]!);

    expect(await docStore.compact(DOC_A, Y.encodeStateAsUpdate(atFirst), folded, null)).toBe(true);

    expect(await docStore.countUpdates(DOC_A)).toBe(1);
    expect(applyAll(await docStore.load(DOC_A)).getText(TEXT).toString()).toBe('ab');
  });

  it('still loads correctly if the covered rows were never deleted', async () => {
    // The state a crash would leave if the snapshot and the delete were not one
    // transaction, in the harmless direction: the snapshot exists and its rows
    // do too. They fall outside the tail filter, so the load ignores them and
    // the text is right — they are inert until something deletes them. The
    // opposite order (rows gone, snapshot missing) is data loss, which is why
    // compact() never splits the two.
    const { doc, updates } = recordingDoc();
    doc.getText(TEXT).insert(0, 'a');
    doc.getText(TEXT).insert(1, 'b');

    let last = 0n;
    for (const update of updates) last = await docStore.appendUpdate(DOC_A, update);

    await docStore.writeSnapshot(DOC_A, Y.encodeStateAsUpdate(doc), last);

    expect(await prisma.docUpdate.count({ where: { docId: DOC_A } })).toBe(2);

    const loaded = await docStore.load(DOC_A);
    expect(loaded.updates).toHaveLength(0);
    expect(applyAll(loaded).getText(TEXT).toString()).toBe('ab');
  });
});

/**
 * Module 11.1 — the boundary comes out of the log, and the write is guarded.
 *
 * Everything below is about a second server instance appending to, or
 * compacting, the same document. Phase 7 made that reachable; Phase 4's
 * compaction assumed it could not happen.
 */
describe('readForCompaction', () => {
  it('reports the eligible tail, its boundary, and the CAS token', async () => {
    const { doc, updates } = recordingDoc();
    doc.getText(TEXT).insert(0, 'a');
    doc.getText(TEXT).insert(1, 'b');

    let last = 0n;
    for (const update of updates) last = await docStore.appendUpdate(DOC_A, update);
    await docStore.appendUpdate(DOC_B, new Uint8Array([9]));
    await age(DOC_A);

    const candidate = await docStore.readForCompaction(DOC_A, cutoff());

    expect(candidate.updates).toHaveLength(2);
    expect(candidate.throughUpdateId).toBe(last);
    // No snapshot row exists yet.
    expect(candidate.expectedUpdateId).toBeNull();
    expect(candidate.snapshot).toBeNull();
  });

  it('excludes rows newer than the cutoff', async () => {
    const { doc, updates } = recordingDoc();
    doc.getText(TEXT).insert(0, 'a');
    doc.getText(TEXT).insert(1, 'b');

    const old = await docStore.appendUpdate(DOC_A, updates[0]!);
    await age(DOC_A);
    // Appended after the ageing, so this one is inside the margin.
    await docStore.appendUpdate(DOC_A, updates[1]!);

    const candidate = await docStore.readForCompaction(DOC_A, cutoff());

    expect(candidate.updates).toHaveLength(1);
    expect(candidate.throughUpdateId).toBe(old);
  });

  it('reports no boundary at all when every row is inside the cutoff', async () => {
    await docStore.appendUpdate(DOC_A, new Uint8Array([1]));
    await docStore.appendUpdate(DOC_A, new Uint8Array([2]));

    const candidate = await docStore.readForCompaction(DOC_A, cutoff());

    // Null, not 0n: a caller that read this as "fold through zero" would delete
    // nothing but still move the watermark backwards.
    expect(candidate.throughUpdateId).toBeNull();
    expect(candidate.updates).toEqual([]);
  });

  it('applies the same tail filter as load', async () => {
    const { doc, updates } = recordingDoc();
    doc.getText(TEXT).insert(0, 'a');
    doc.getText(TEXT).insert(1, 'b');

    const first = await docStore.appendUpdate(DOC_A, updates[0]!);
    const second = await docStore.appendUpdate(DOC_A, updates[1]!);
    await age(DOC_A);

    // A snapshot that already folded the first row, without deleting it.
    await docStore.writeSnapshot(DOC_A, new Uint8Array([7]), first);

    const candidate = await docStore.readForCompaction(DOC_A, cutoff());

    expect(candidate.updates).toHaveLength(1);
    expect(candidate.throughUpdateId).toBe(second);
    expect(candidate.expectedUpdateId).toBe(first);
    expect(Array.from(candidate.snapshot!)).toEqual([7]);
  });
});

describe('compact — compare-and-set', () => {
  it('refuses, and deletes nothing, when the snapshot moved since the read', async () => {
    const { doc, updates } = recordingDoc();
    doc.getText(TEXT).insert(0, 'a');
    doc.getText(TEXT).insert(1, 'b');

    let last = 0n;
    for (const update of updates) last = await docStore.appendUpdate(DOC_A, update);

    // Another instance compacted first and left the watermark somewhere else.
    await docStore.writeSnapshot(DOC_A, new Uint8Array([9, 9]), 7n);

    const won = await docStore.compact(DOC_A, Y.encodeStateAsUpdate(doc), 99n, last);

    expect(won).toBe(false);
    // Both halves untouched: the rows are still there and the snapshot is
    // still the other compactor's.
    expect(await docStore.countUpdates(DOC_A)).toBe(2);
    const rows = await prisma.docSnapshot.findMany({ where: { docId: DOC_A } });
    expect(Array.from(rows[0]!.snapshot)).toEqual([9, 9]);
    expect(rows[0]!.updateId).toBe(7n);
  });

  it('refuses when a snapshot appeared where the read saw none', async () => {
    await docStore.appendUpdate(DOC_A, new Uint8Array([1]));
    const last = await docStore.appendUpdate(DOC_A, new Uint8Array([2]));

    // The read returned expectedUpdateId: null; a racer created one since.
    await docStore.writeSnapshot(DOC_A, new Uint8Array([5]), 1n);

    // A unique-constraint violation, surfaced as a lost CAS rather than a throw.
    await expect(docStore.compact(DOC_A, new Uint8Array([6]), last, null)).resolves.toBe(false);

    expect(await docStore.countUpdates(DOC_A)).toBe(2);
    const rows = await prisma.docSnapshot.findMany({ where: { docId: DOC_A } });
    expect(Array.from(rows[0]!.snapshot)).toEqual([5]);
  });

  it('advances the watermark and deletes only what it folded', async () => {
    const { doc, updates } = recordingDoc();
    doc.getText(TEXT).insert(0, 'a');
    doc.getText(TEXT).insert(1, 'b');
    doc.getText(TEXT).insert(2, 'c');

    const first = await docStore.appendUpdate(DOC_A, updates[0]!);
    await docStore.writeSnapshot(DOC_A, updates[0]!, first);

    await docStore.appendUpdate(DOC_A, updates[1]!);
    await age(DOC_A);
    const third = await docStore.appendUpdate(DOC_A, updates[2]!);

    const candidate = await docStore.readForCompaction(DOC_A, cutoff());
    const folded = new Y.Doc();
    if (candidate.snapshot) Y.applyUpdate(folded, candidate.snapshot);
    for (const update of candidate.updates) Y.applyUpdate(folded, update);

    const won = await docStore.compact(
      DOC_A,
      Y.encodeStateAsUpdate(folded),
      candidate.throughUpdateId!,
      candidate.expectedUpdateId,
    );

    expect(won).toBe(true);
    // The third row was inside the cutoff, so it was never a candidate and is
    // still in the log — and still above the new watermark, so load returns it.
    expect(await docStore.countUpdates(DOC_A)).toBe(1);
    const loaded = await docStore.load(DOC_A);
    expect(loaded.lastUpdateId).toBe(third);
    expect(applyAll(loaded).getText(TEXT).toString()).toBe('abc');
  });

  it('throws rather than moving the watermark backwards', async () => {
    await docStore.appendUpdate(DOC_A, new Uint8Array([1]));
    await docStore.writeSnapshot(DOC_A, new Uint8Array([2]), 10n);

    // Folding through 10 when 10 is already folded deletes rows for a snapshot
    // that does not advance. There is no correct way to continue, so it is loud.
    await expect(docStore.compact(DOC_A, new Uint8Array([3]), 10n, 10n)).rejects.toThrow(
      /does not advance/,
    );

    expect(await docStore.countUpdates(DOC_A)).toBe(1);
  });

  it('folds a document that has no snapshot yet', async () => {
    const { doc, updates } = recordingDoc();
    doc.getText(TEXT).insert(0, 'a');
    const last = await docStore.appendUpdate(DOC_A, updates[0]!);
    await age(DOC_A);

    const candidate = await docStore.readForCompaction(DOC_A, PAST_EVERYTHING);
    expect(candidate.expectedUpdateId).toBeNull();

    expect(
      await docStore.compact(DOC_A, Y.encodeStateAsUpdate(doc), last, candidate.expectedUpdateId),
    ).toBe(true);

    expect(await docStore.countUpdates(DOC_A)).toBe(0);
    expect(applyAll(await docStore.load(DOC_A)).getText(TEXT).toString()).toBe('a');
  });
});

describe('countUpdates and deleteDoc', () => {
  it('counts, deletes both tables, and leaves other documents alone', async () => {
    await docStore.appendUpdate(DOC_A, new Uint8Array([1]));
    await docStore.appendUpdate(DOC_A, new Uint8Array([2]));
    await docStore.writeSnapshot(DOC_A, new Uint8Array([3]), 0n);
    await docStore.appendUpdate(DOC_B, new Uint8Array([4]));

    expect(await docStore.countUpdates(DOC_A)).toBe(2);

    await docStore.deleteDoc(DOC_A);

    expect(await docStore.countUpdates(DOC_A)).toBe(0);
    expect((await docStore.load(DOC_A)).exists).toBe(false);
    expect(await prisma.docSnapshot.count({ where: { docId: DOC_A } })).toBe(0);

    // The neighbouring document survives.
    expect((await docStore.load(DOC_B)).exists).toBe(true);
  });

  it('deleting an unknown document succeeds', async () => {
    await expect(docStore.deleteDoc('gone:gone')).resolves.toBeUndefined();
  });
});
