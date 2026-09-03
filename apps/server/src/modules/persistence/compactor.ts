import * as Y from 'yjs';

import type { CompactionCandidate, DocStore } from './DocStore.js';

/**
 * Keeping the log short (ADR-002).
 *
 * An append-only log alone would replay every keystroke-batch a document has
 * ever had on every cold open. Past a threshold the document folds into one
 * snapshot and the rows it covers are deleted, in a single transaction.
 *
 * Since module 11.2 this file needs no `Y.Doc` from anywhere: it reads bytes
 * out of the log, folds them, and writes bytes back. That is the whole of the
 * cross-instance fix — see `foldCandidate` — and it is also what would let a
 * background sweep compact a document nobody has open.
 */

/** Rows, not bytes: this is about how much a cold load has to replay. */
const COMPACT_AFTER = 200;

/**
 * How far behind "now" the fold boundary has to sit (module 11.1).
 *
 * `DocUpdate.id` is a sequence value, and a sequence value is allocated before
 * its transaction commits — so a row with a *lower* id can become visible after
 * a compaction has read past it. It would survive the delete and then be hidden
 * forever by `load`'s `id > snapshot.updateId` filter. An append is one
 * statement, so the gap between its `createdAt` and its commit is microseconds;
 * thirty seconds is about six orders of magnitude of headroom.
 *
 * The cost is that the newest few rows of a document are never folded, which
 * does not matter when the threshold is 200. This is a margin, not a proof: it
 * assumes an append never stalls between timestamp and commit for half a
 * minute.
 */
const COMPACT_LAG_MS = 30_000;

/**
 * The state through the compaction boundary, built from the log alone.
 *
 * This is module 11.2, and it is the whole of it. Compaction used to snapshot
 * `Y.encodeStateAsUpdate(room.ydoc)` — *this* instance's document — and then
 * delete every row up to the boundary. That is only sound while one process
 * writes the log. Since Phase 7 a second instance appends to the same log, and
 * the doc bus that would have carried its edits here is at-most-once (ADR-003),
 * so a row can exist in the database having never reached this Y.Doc. Folding
 * the local document and deleting that row destroys it permanently.
 *
 * The bytes about to be deleted are exactly the bytes folded here, so the
 * snapshot covers them by construction, whoever wrote them and whether or not
 * this process ever saw them.
 *
 * A throwaway `Y.Doc` rather than `Y.mergeUpdates`: merging concatenates update
 * payloads without collecting deleted content, so the snapshot would grow with
 * the document's edit *history* instead of its size. Applying and re-encoding
 * produces the compact form Phase 4 wrote, and produces the same bytes no
 * matter which instance runs it.
 */
function foldCandidate(candidate: CompactionCandidate): Uint8Array {
  const folded = new Y.Doc();

  // Snapshot first, then the tail in id order — the same order `load` uses, and
  // the only order in which the result is the state at the boundary.
  if (candidate.snapshot) Y.applyUpdate(folded, candidate.snapshot);
  for (const update of candidate.updates) Y.applyUpdate(folded, update);

  return Y.encodeStateAsUpdate(folded);
}

/**
 * Called from inside the buffer's serialized flush chain, so no append from this
 * process can interleave. A second server instance can, which is what everything
 * here is about.
 *
 * Takes no `Y.Doc`. Since module 11.1 the boundary comes out of the log rather
 * than from the id this flush happened to append, and since 11.2 the bytes do
 * too — so nothing about compaction depends on what this process has in memory.
 */
export async function maybeCompact(docId: string, store: DocStore): Promise<void> {
  // One indexed count per flush — about once every couple of seconds per
  // actively edited document, not per keystroke.
  if ((await store.countUpdates(docId)) <= COMPACT_AFTER) return;

  const candidate = await store.readForCompaction(docId, new Date(Date.now() - COMPACT_LAG_MS));

  // Every row is still inside the safety margin. Normal for a document being
  // typed into quickly; the next flush reconsiders.
  if (candidate.throughUpdateId === null) return;

  // A false return means another compactor won the compare-and-set and this
  // call wrote and deleted nothing — an ordinary outcome, not an error.
  await store.compact(
    docId,
    foldCandidate(candidate),
    candidate.throughUpdateId,
    candidate.expectedUpdateId,
  );
}
