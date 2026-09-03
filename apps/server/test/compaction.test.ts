import { Y_TEXT_KEY } from '@collab/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { attachPersistence, docStore } from '../src/modules/persistence/index.js';
import { prisma, resetDb } from './helpers/db.js';

/**
 * Module 11.3 — compaction with more than one writer on the log.
 *
 * Two server instances share one PostgreSQL database (Phase 7) and the doc bus
 * between them is at-most-once (ADR-003). Every case below models that: two
 * independent `Y.Doc`s over one `docId`, neither of which ever receives the
 * other's updates. That is not a contrived setup — it is the state of a
 * document whose bus frame was dropped, and the state Phase 4's compaction
 * quietly assumed could not exist.
 *
 * No rooms and no sockets: `docId` has no foreign key, so a synthetic id is
 * enough, and `materializeContent`'s `updateMany` touches zero rows for a file
 * that does not exist rather than throwing. That keeps this file about the
 * write path and nothing else.
 */

const DOC = 'projectX:fileX';
const FILE_ID = 'fileX';

/** One instance's view of the document: its own Y.Doc and its own buffer. */
function instance(): { ydoc: Y.Doc; flush: () => Promise<void>; detach: () => void } {
  const ydoc = new Y.Doc();
  const persistence = attachPersistence({ docId: DOC, fileId: FILE_ID, ydoc, store: docStore });
  return { ydoc, flush: persistence.flush, detach: persistence.detach };
}

/**
 * Backdates the log past COMPACT_LAG_MS.
 *
 * The 30s cutoff is wall-clock and nothing a test writes is ever that old, so
 * without this no candidate is ever eligible and compaction never fires.
 */
async function age(): Promise<void> {
  await prisma.docUpdate.updateMany({
    where: { docId: DOC },
    data: { createdAt: new Date(Date.now() - 60_000) },
  });
}

/** A cold reader: the document as a restarting instance would rebuild it. */
async function reconstruct(): Promise<string> {
  const loaded = await docStore.load(DOC);
  const doc = new Y.Doc();
  if (loaded.snapshot) Y.applyUpdate(doc, loaded.snapshot);
  for (const update of loaded.updates) Y.applyUpdate(doc, update);
  return doc.getText(Y_TEXT_KEY).toString();
}

beforeEach(async () => {
  await resetDb();
});

describe('compaction across instances', () => {
  it('preserves the other instance’s updates through a compaction', async () => {
    const a = instance();
    const b = instance();

    // Each instance writes text the other never sees. In production the doc bus
    // would usually carry these across; at-most-once means "usually".
    a.ydoc.getText(Y_TEXT_KEY).insert(0, 'alpha');
    await a.flush();
    b.ydoc.getText(Y_TEXT_KEY).insert(0, 'beta');
    await b.flush();

    expect(a.ydoc.getText(Y_TEXT_KEY).toString()).not.toContain('beta');
    expect(b.ydoc.getText(Y_TEXT_KEY).toString()).not.toContain('alpha');

    // Instance A alone drives the log past the threshold, so A is the one that
    // compacts — and B's row is inside the boundary A is about to delete.
    for (let i = 0; i < 201; i += 1) {
      a.ydoc.getText(Y_TEXT_KEY).insert(0, 'x');
      await a.flush();
    }
    await age();

    a.ydoc.getText(Y_TEXT_KEY).insert(0, 'x');
    await a.flush();

    // Folded: only the row from that last flush, still inside the cutoff, is left.
    expect(await docStore.countUpdates(DOC)).toBe(1);

    const text = await reconstruct();
    expect(text).toContain('alpha');
    // Race B. Snapshotting A's live Y.Doc would have deleted B's row while
    // holding no copy of what was in it.
    expect(text).toContain('beta');

    a.detach();
    b.detach();
  });

  it('lets only one of two racing compactors win, and loses nothing', async () => {
    const a = instance();
    a.ydoc.getText(Y_TEXT_KEY).insert(0, 'shared');
    await a.flush();
    a.detach();

    const other = new Y.Doc();
    other.getText(Y_TEXT_KEY).insert(0, 'remote');
    await docStore.appendUpdate(DOC, Y.encodeStateAsUpdate(other));
    await age();

    // Both instances read the same candidate: same rows, same CAS token. This
    // is the overlap Phase 4 had no defence against.
    const first = await docStore.readForCompaction(DOC, new Date(Date.now() - 30_000));
    const second = await docStore.readForCompaction(DOC, new Date(Date.now() - 30_000));
    expect(second.expectedUpdateId).toBe(first.expectedUpdateId);
    expect(second.throughUpdateId).toBe(first.throughUpdateId);

    function fold(candidate: typeof first): Uint8Array {
      const doc = new Y.Doc();
      if (candidate.snapshot) Y.applyUpdate(doc, candidate.snapshot);
      for (const update of candidate.updates) Y.applyUpdate(doc, update);
      return Y.encodeStateAsUpdate(doc);
    }

    const results = await Promise.all([
      docStore.compact(DOC, fold(first), first.throughUpdateId!, first.expectedUpdateId),
      docStore.compact(DOC, fold(second), second.throughUpdateId!, second.expectedUpdateId),
    ]);

    // Exactly one; the loser wrote nothing and deleted nothing.
    expect(results.filter(Boolean)).toHaveLength(1);

    // One snapshot, one fold, and the log pruned exactly once.
    expect(await prisma.docSnapshot.count({ where: { docId: DOC } })).toBe(1);
    expect(await docStore.countUpdates(DOC)).toBe(0);

    const text = await reconstruct();
    expect(text).toContain('shared');
    expect(text).toContain('remote');
  });

  it('reconstructs the same document whichever instance folded it', async () => {
    const a = instance();
    a.ydoc.getText(Y_TEXT_KEY).insert(0, 'alpha');
    await a.flush();

    const b = instance();
    b.ydoc.getText(Y_TEXT_KEY).insert(0, 'beta');
    await b.flush();
    await age();

    const candidate = await docStore.readForCompaction(DOC, new Date(Date.now() - 30_000));

    // The fold is a pure function of the log, so both instances compute the
    // same bytes from the same rows — there is no "whose document was it".
    function fold(): Uint8Array {
      const doc = new Y.Doc();
      if (candidate.snapshot) Y.applyUpdate(doc, candidate.snapshot);
      for (const update of candidate.updates) Y.applyUpdate(doc, update);
      return Y.encodeStateAsUpdate(doc);
    }

    const fromA = fold();
    const fromB = fold();
    expect(Array.from(fromB)).toEqual(Array.from(fromA));

    expect(
      await docStore.compact(DOC, fromA, candidate.throughUpdateId!, candidate.expectedUpdateId),
    ).toBe(true);

    const text = await reconstruct();
    expect(text).toContain('alpha');
    expect(text).toContain('beta');

    a.detach();
    b.detach();
  });
});
