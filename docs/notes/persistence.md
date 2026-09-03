# Persistence — op log vs snapshots

Working notes from Phase 4. What is needed to reason about the storage layer,
not a tutorial. Companion to `yjs.md`.

**The three options, and why the middle one.** *Write the whole document on every
change*: simple, and it multiplies one keystroke into a full-document write —
write amplification, and it gets worse as the file grows. *Snapshot periodically
and nothing else*: cheap, and it loses everything typed since the last snapshot
when the process dies. *Append-only log + periodic snapshot*: each change costs
one small row, and a crash loses only what has not been flushed yet. That is
ADR-002, and it is the standard shape for event-sourced state.

**Load is snapshot + tail.** Read the one snapshot, then every update with a
greater id, in id order. The snapshot is an optimisation, never the source of
truth — delete every snapshot and the log alone still reconstructs the document.
That is the property that makes compaction safe to get wrong in one direction.

**Compaction is the other half.** Without it the log grows forever and a cold
open replays every batch the document has ever had. Past a threshold, fold the
rows themselves into a fresh snapshot and delete the rows it covers. The two must
be one transaction: a crash *after* the snapshot but *before* the delete leaves
rows that are already folded in, and replaying an update Yjs already has is a
no-op — harmless. The reverse order is data loss.

**Ordering inside the transaction does matter, and atomicity alone is not
enough** (corrected in Phase 11; this used to say the opposite). The snapshot
write is a **compare-and-set** on `DocSnapshot.updateId`, and the sequence is
fixed: CAS first, and the delete only once the CAS has succeeded. A failed CAS
deletes nothing at all — it means another instance compacted since this one read
its candidate, and that instance's snapshot may already cover rows this boundary
would prune. Deleting first, or deleting regardless, destroys them. So: atomicity
keeps the two halves together, and the ordering is what makes the pair safe when
two instances attempt it at once.

**Why store CRDT updates and not text.** Rebuilding a `Y.Doc` from a plain string
gives its items brand-new client ids, so two peers that both "restored" the same
file no longer agree on what any character *is* — they merge as duplicates rather
than as the same edit. Storing the real binary updates keeps document identity
stable across restarts. Nothing noticed while there was no client-side
persistence; `y-indexeddb` (5.1) would have found it immediately, which is why it
was blocked on this phase.

**Batching is what makes it affordable.** A naive `ydoc.on('update')` → one row
per keystroke. Buffering with a 2s debounce (or 64KB, whichever first) and
merging the batch into one row turns a paragraph of typing into a single write.
Yjs updates merge losslessly, so the merged row is not an approximation. The
cost is the honest trade: a hard kill loses up to the debounce window.

**Debounce, not throttle-per-event.** A debounce restarted on every keystroke
never fires while someone is actually typing. The clock starts on the first
update after a flush and is not reset — so a flush happens every ~2s during
sustained typing rather than only when the typist pauses.

**Derived state must lag, never lead.** `File.content` is a plain-text projection
kept for consumers that must not load a CRDT (the Phase 6 runner, file listings).
It is written *after* the append that produced it, and a failure to write it is
logged and dropped — never rolled back. The log is the truth; failing real edits
to protect a projection of them has it backwards.
