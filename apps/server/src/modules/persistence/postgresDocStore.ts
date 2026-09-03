import { prisma } from '../../db.js';
import type { CompactionCandidate, DocStore, LoadedDoc } from './DocStore.js';

/**
 * The DocStore over PostgreSQL — the only implementation.
 *
 * It knows nothing about Yjs: updates and snapshots are opaque byte arrays it
 * stores and returns unexamined, and `docId` is an opaque string it never
 * parses. That is what keeps the swap-the-backing-store promise real.
 *
 * Prisma maps `Bytes` to `Uint8Array` (runtime.Bytes = ReturnType<Uint8Array
 * ['slice']>), so nothing here converts in either direction. The pg adapter may
 * hand back a Node Buffer at runtime — a Uint8Array subclass, transparent to
 * every consumer — but that is exactly why callers must treat what comes out as
 * an opaque view and never do `.buffer` / `.byteOffset` arithmetic on it: a
 * pooled Buffer's bytes do not start at offset zero.
 *
 * `DocUpdate.id` and `DocSnapshot.updateId` are BigInt, so ids are JS `bigint`
 * throughout. They never cross the HTTP boundary — JSON.stringify throws on a
 * bigint, and the only reason that never bites is that nothing serializes them.
 *
 * There is deliberately **no try/catch**. An unknown document is not an error
 * (it returns exists: false), but a real database failure must propagate: module
 * 4.3's caller refuses to open the document rather than silently seeding an
 * empty one over content that exists.
 */
/**
 * Copies bytes into an ArrayBuffer-backed view before writing.
 *
 * Prisma's Bytes input is `Uint8Array<ArrayBuffer>`, while a plain `Uint8Array`
 * — what the interface promises and what Yjs and lib0 produce — is
 * `Uint8Array<ArrayBufferLike>`, which also admits a SharedArrayBuffer. Phase 3
 * hit the same wall passing lib0's output to WebSocket.send and solved it the
 * same way. A cast would be free but would be a lie; this is one small copy per
 * flush, not per keystroke.
 *
 * Reads need no equivalent: `Uint8Array<ArrayBuffer>` is assignable to the
 * looser type, so what comes out of the store is returned untouched.
 */
function toStoredBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * A unique-constraint violation, structurally.
 *
 * Only `compact`'s create branch needs it: the unique index on
 * `DocSnapshot.docId` *is* the compare-and-set when there is no snapshot to
 * compare against, so P2002 there means "another compactor got here first",
 * not a failure. Read off the shape rather than importing Prisma's error class,
 * which keeps this file free of anything but the client it already uses.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

export const postgresDocStore: DocStore = {
  async load(docId: string): Promise<LoadedDoc> {
    const snapshot = await prisma.docSnapshot.findUnique({
      where: { docId },
      select: { snapshot: true, updateId: true },
    });

    const rows = await prisma.docUpdate.findMany({
      // Ids start at 1, so with no snapshot this filter degenerates to "every
      // update for this document", which is what a cold load wants.
      where: { docId, id: { gt: snapshot?.updateId ?? 0n } },
      // Not optional: Postgres promises no ordering without it, and an
      // unordered tail is a bug that only shows up under load.
      orderBy: { id: 'asc' },
      select: { id: true, update: true },
    });

    const lastRow = rows.at(-1);

    return {
      exists: snapshot !== null || rows.length > 0,
      snapshot: snapshot?.snapshot ?? null,
      updates: rows.map((row) => row.update),
      lastUpdateId: lastRow?.id ?? snapshot?.updateId ?? null,
    };
  },

  async appendUpdate(docId: string, update: Uint8Array): Promise<bigint> {
    // One row, bytes untouched. Callers merge a flush's updates before calling,
    // so the log grows per flush rather than per keystroke (module 4.3).
    const row = await prisma.docUpdate.create({
      data: { docId, update: toStoredBytes(update) },
      select: { id: true },
    });

    return row.id;
  },

  async writeSnapshot(docId: string, snapshot: Uint8Array, throughUpdateId: bigint): Promise<void> {
    // Upsert because docId is unique: one snapshot per document, replaced in
    // place rather than accumulated. It deletes nothing — module 4.4 pairs this
    // with the delete of superseded rows inside a transaction it owns, which is
    // what makes a half-finished compaction impossible from here.
    const stored = toStoredBytes(snapshot);

    await prisma.docSnapshot.upsert({
      where: { docId },
      create: { docId, snapshot: stored, updateId: throughUpdateId },
      update: { snapshot: stored, updateId: throughUpdateId },
    });
  },

  async readForCompaction(docId: string, cutoff: Date): Promise<CompactionCandidate> {
    // Interactive because the second query's filter depends on the first's
    // result, and RepeatableRead because the snapshot bytes and the tail must
    // describe one moment: module 11.2 merges them together, and a snapshot
    // read before a competing compaction paired with rows read after it would
    // be a state with a hole in it. The CAS in compact() would reject the
    // result anyway — this is what makes it never get that far.
    return prisma.$transaction(
      async (tx) => {
        const snapshot = await tx.docSnapshot.findUnique({
          where: { docId },
          select: { snapshot: true, updateId: true },
        });

        const rows = await tx.docUpdate.findMany({
          // The same tail filter load() uses — rows already folded in are not
          // candidates — narrowed further by the caller's safety margin.
          where: {
            docId,
            id: { gt: snapshot?.updateId ?? 0n },
            createdAt: { lt: cutoff },
          },
          orderBy: { id: 'asc' },
          select: { id: true, update: true },
        });

        return {
          snapshot: snapshot?.snapshot ?? null,
          expectedUpdateId: snapshot?.updateId ?? null,
          updates: rows.map((row) => row.update),
          // Null, not 0n: "nothing to fold" and "fold through id zero" are
          // different instructions and only one of them is safe.
          throughUpdateId: rows.at(-1)?.id ?? null,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  },

  async compact(
    docId: string,
    snapshot: Uint8Array,
    throughUpdateId: bigint,
    expectedUpdateId: bigint | null,
  ): Promise<boolean> {
    if (expectedUpdateId !== null && throughUpdateId <= expectedUpdateId) {
      // Deleting `id <= throughUpdateId` while moving the watermark backwards
      // would drop rows the new snapshot does not contain. Loud, because there
      // is no correct way to continue.
      throw new Error(
        `compact(${docId}): boundary ${throughUpdateId} does not advance past ${expectedUpdateId}`,
      );
    }

    const stored = toStoredBytes(snapshot);

    try {
      // One transaction: the snapshot must exist before — or with — the delete
      // of the rows it covers, never after. Interactive rather than the array
      // form because the delete is conditional on the CAS having won, and an
      // array transaction cannot branch.
      return await prisma.$transaction(async (tx) => {
        if (expectedUpdateId === null) {
          // No snapshot was there at read time. The unique index on docId is
          // the CAS here: a racer that created one in the meantime makes this
          // throw P2002, the transaction roll back, and the delete never run.
          await tx.docSnapshot.create({
            data: { docId, snapshot: stored, updateId: throughUpdateId },
          });
        } else {
          const { count } = await tx.docSnapshot.updateMany({
            where: { docId, updateId: expectedUpdateId },
            data: { snapshot: stored, updateId: throughUpdateId },
          });

          // Someone else compacted since the read, and their snapshot may
          // already cover rows this boundary would delete. Returning here —
          // BEFORE the delete — is the entire point of the compare-and-set.
          if (count !== 1) return false;
        }

        await tx.docUpdate.deleteMany({ where: { docId, id: { lte: throughUpdateId } } });
        return true;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  },

  async countUpdates(docId: string): Promise<number> {
    return prisma.docUpdate.count({ where: { docId } });
  },

  async deleteDoc(docId: string): Promise<void> {
    // deleteMany, not delete: an unknown document affects zero rows and
    // succeeds, so the contract's idempotence costs the caller no try/catch.
    // One transaction so a document can never be left as a snapshot with no log
    // or a log with no snapshot.
    await prisma.$transaction([
      prisma.docUpdate.deleteMany({ where: { docId } }),
      prisma.docSnapshot.deleteMany({ where: { docId } }),
    ]);
  },
};
