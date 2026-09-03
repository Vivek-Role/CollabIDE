/**
 * Storage for Yjs document state.
 *
 * Binary updates in, binary updates out — no Yjs semantics live here. An
 * implementation may not import `yjs`, construct a Y.Doc, merge updates or read
 * text: the caller owns the document, this owns only its bytes. That is what
 * makes the backing store swappable in one folder, as CLAUDE.md has promised
 * since Phase 0.
 *
 * ADR-002: an append-only log of updates plus a periodic snapshot, so a load is
 * "latest snapshot + the updates after it". Not a whole-document write per
 * change (write amplification per keystroke), and not snapshot-only (which
 * loses everything typed since the last snapshot on a crash).
 *
 * Module 4.2 implements this over PostgreSQL; module 4.3 is the first caller.
 * Nothing uses it yet.
 */

/**
 * A document's persisted state, as stored — the caller applies it.
 *
 * `docId` is `${projectId}:${fileId}` throughout, the format `makeDocId`
 * produces. It is taken as an opaque string: this module does not parse it and
 * does not import from `@collab/shared` to do so.
 */
export interface LoadedDoc {
  /**
   * False only when this document has never been persisted — the one condition
   * that permits seeding from `File.content`.
   *
   * Stored, not derived. `!snapshot && !updates.length` happens to mean the
   * same thing today, but only because a seed always writes its snapshot
   * first; a caller that re-derives that wrongly re-seeds from `File.content`
   * and the document's text appears twice. A persisted-but-empty document has
   * `exists: true` and a snapshot encoding an empty Y.Doc.
   */
  exists: boolean;

  /** Apply first. Null when nothing has been snapshotted yet. */
  snapshot: Uint8Array | null;

  /** Every update after the snapshot, in ascending id order. Apply after it. */
  updates: Uint8Array[];

  /**
   * The highest update id represented here: the tail's last id, else the
   * snapshot's `throughUpdateId`, else null. Compaction needs to know what it
   * is folding.
   */
  lastUpdateId: bigint | null;
}

/**
 * What compaction is allowed to fold, read out of the log itself.
 *
 * Module 11.1. The boundary a compaction deletes to must come from rows the
 * store actually returned — never from a live Y.Doc's idea of what it has
 * applied. A second server instance appends to the same log (Phase 7) and the
 * doc bus is at-most-once, so this process's document is not evidence about
 * anyone else's rows.
 */
export interface CompactionCandidate {
  /** The snapshot these updates sit on top of, or null when there is none. */
  snapshot: Uint8Array | null;

  /**
   * The CAS token: `DocSnapshot.updateId` as it stood when this was read, or
   * null when no snapshot row exists. Handed straight back to `compact`, which
   * refuses to write if it has moved since.
   */
  expectedUpdateId: bigint | null;

  /** The eligible updates, in ascending id order. */
  updates: Uint8Array[];

  /**
   * The highest id in `updates`, or null when nothing is eligible — the normal
   * answer for a document whose whole log is younger than the cutoff. A null
   * boundary means "do not compact", never "compact everything".
   */
  throughUpdateId: bigint | null;
}

export interface DocStore {
  /**
   * The snapshot, then every update appended after it, in ascending id order.
   *
   * An unknown document is not an error — it returns `exists: false` with an
   * empty tail. A genuine storage failure *does* throw, and the caller refuses
   * to open the document rather than silently starting from nothing: an empty
   * editor over a document that has content reads as "my work is gone", and
   * once the user types, that emptiness becomes real.
   */
  load(docId: string): Promise<LoadedDoc>;

  /**
   * Appends exactly one row and returns its id.
   *
   * Does not merge, inspect or validate the bytes. Callers merge a flush's
   * updates before calling, so the log grows by one row per flush rather than
   * one per keystroke.
   */
  appendUpdate(docId: string, update: Uint8Array): Promise<bigint>;

  /**
   * Replaces this document's snapshot in place — one per document, never
   * accumulated. `throughUpdateId` is the highest update folded into it, or
   * `0n` for a snapshot that folds none.
   *
   * **Deletes nothing** — that is `compact`'s job. A seed snapshot has no rows
   * to supersede, and keeping the two apart is what makes it impossible to
   * delete rows here by accident.
   */
  writeSnapshot(docId: string, snapshot: Uint8Array, throughUpdateId: bigint): Promise<void>;

  /**
   * The rows a compaction may fold, plus the token that proves nothing moved.
   *
   * `cutoff` bounds the read by `createdAt`: rows younger than it are never
   * eligible. `DocUpdate.id` comes from a sequence, and a sequence value is
   * allocated *before* its transaction commits, so a row with a lower id can
   * become visible after a compaction has already read past it. Such a row
   * survives the delete — Postgres cannot delete a row the deleting statement
   * cannot see — but it then sits below `DocSnapshot.updateId`, where `load`'s
   * tail filter hides it for good. The cutoff is what makes that unreachable:
   * an append is a single statement, so `createdAt` and commit are microseconds
   * apart, while the caller's margin is measured in seconds.
   *
   * Applies the same tail filter as `load`, so rows already folded into the
   * current snapshot are not returned. Module 11.1.
   */
  readForCompaction(docId: string, cutoff: Date): Promise<CompactionCandidate>;

  /**
   * Atomically replace the snapshot **and** delete every update folded into it,
   * but only if `expectedUpdateId` is still the stored `updateId`.
   *
   * One call rather than two because the halves must not be separable: a crash
   * after the delete but before the snapshot is data loss, while the other order
   * is harmless — Yjs applying an update already folded in is a no-op.
   *
   * `expectedUpdateId` (module 11.1) is the compare-and-set that makes a second
   * server instance safe. Two compactors racing one document would otherwise
   * interleave as: A folds through 100, B folds through 150 and deletes
   * 101-150, then A's write puts the watermark back to 100 — with the rows
   * between them already gone. The CAS turns that into a no-op for whichever
   * compactor is second.
   *
   * Returns **false** when the CAS lost. That answer guarantees *nothing was
   * written and nothing was deleted*; the caller's next flush tries again
   * against a longer log. Throws if the boundary does not advance past
   * `expectedUpdateId` — a compaction that folds nothing is a caller bug, not a
   * silent no-op.
   *
   * Added in module 4.4. `writeSnapshot` stays for the seed path, which has no
   * rows to supersede and therefore nothing to compare against.
   */
  compact(
    docId: string,
    snapshot: Uint8Array,
    throughUpdateId: bigint,
    expectedUpdateId: bigint | null,
  ): Promise<boolean>;

  /** How many rows are currently in the log for this document — the signal that
   *  decides when to compact. Read on the flush path, so it stays a count. */
  countUpdates(docId: string): Promise<number>;

  /** The snapshot and every update, gone — for a deleted file or project.
   *  Idempotent: deleting an unknown document succeeds. */
  deleteDoc(docId: string): Promise<void>;
}
