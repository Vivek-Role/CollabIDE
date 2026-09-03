# ADR-002 — Persistence: an append-only op log, periodic snapshots, and compaction

**Status:** Accepted · **Decided:** Phase 4 (2026-08-13) · **Implemented:** modules 4.1–4.4
**Amended:** Phase 11 (2026-09-02), modules 11.1–11.3 — compaction made safe across instances
**Code:** `apps/server/src/modules/persistence/` · Prisma models `DocUpdate`, `DocSnapshot`, `File`

---

## Context

Before Phase 4 a document's only durable copy was plain text written to `File.content` when
the last editor left the room. A `kill -9` lost the entire session, and rebuilding a
`Y.Doc` from a string gave its items new client ids every time — so restored peers merged
as duplicates rather than converging.

A collaborative editor needs a durability story that survives a hard kill without writing
to the database on every keystroke.

## Decision

**Persist Yjs binary updates to an append-only log, snapshot periodically, and compact.**

```
load    = latest DocSnapshot + every DocUpdate with a greater id, in id order
write   = ydoc.on('update') -> buffer -> merged into ONE row per flush
flush   = 2s debounce OR 64KB, whichever comes first
          forced on last disconnect and on shutdown
compact = >200 rows -> read the eligible log -> fold it -> snapshot + delete
          the rows it covers, in ONE transaction, behind a compare-and-set
```

The real constants, so no reader has to guess: `FLUSH_DELAY_MS = 2_000` and
`FLUSH_BYTES = 64 * 1024` (`buffer.ts:27-28`), `COMPACT_AFTER = 200` and
`COMPACT_LAG_MS = 30_000` (`compactor.ts`).

Storage sits behind a **`DocStore` interface** (`DocStore.ts`) — `load`, `appendUpdate`,
`writeSnapshot`, `readForCompaction`, `compact`, `countUpdates`, `deleteDoc` — so the
backing store is swappable by changing one line, `docStore` in the persistence barrel. The
PostgreSQL implementation is the only one that exists.

### Compaction, as finally built (Phase 11)

Phase 4 folded **this instance's live `Y.Doc`** and deleted every row up to **the id this
flush had just appended**. Both halves of that were single-writer assumptions, and ADR-003
made them false. The final design takes everything from the log instead:

- **Log-derived boundary.** `readForCompaction(docId, cutoff)` returns the eligible rows,
  the highest id among them, and the snapshot they sit on. Nothing about the boundary comes
  from process memory.
- **30-second age cutoff.** No row younger than `COMPACT_LAG_MS` is ever eligible.
  `DocUpdate.id` is a sequence value allocated *before* its transaction commits, so a lower
  id can become visible after compaction has read past it; such a row survives the delete
  (Postgres cannot delete what it cannot see) and is then hidden forever by `load`'s tail
  filter. An append is one statement, so the margin is ~six orders of magnitude.
- **Compare-and-set on `DocSnapshot.updateId`.** `compact` writes only if the stored
  watermark is still `expectedUpdateId`, and the delete runs **only** after the CAS wins.
  A `false` return guarantees nothing was written and nothing was deleted.
- **The snapshot is folded from the persisted updates**, by applying the candidate snapshot
  and its tail into a throwaway `Y.Doc` and re-encoding. The bytes deleted are exactly the
  bytes folded, so the snapshot covers them whoever wrote them. `maybeCompact` therefore
  takes no `Y.Doc` at all — compaction is independent of any live room.

**Safe pruning, stated once:** every row at or below `DocSnapshot.updateId` is folded into
the snapshot and deleted; every row above it survives and is replayed by `load`. There is
no third case.

`load()` was **not** changed — the tail filter is still `id > snapshot.updateId`, and
`writeSnapshot` still owns the seed path and still deletes nothing. No schema migration and
no new dependency were needed. Full derivation and the measurements in
`docs/notes/compaction.md`.

## Alternatives rejected

| Option | Why not |
|---|---|
| **Write the whole document on every change** | Write amplification: a one-character edit rewrites the file. The thing being optimised is exactly the small-frequent-update case |
| **Snapshots only** | Everything between snapshots is lost on a crash. The op log is what makes the window bounded and small |
| **Persist plain text instead of Yjs updates** | The original Phase 3 behaviour, and the reason 5.1 was blocked. Rebuilding a `Y.Doc` from a string gives its items new client ids, so restored peers duplicate rather than merge |
| **A write per keystroke** | Correct, and absurd. The 2 s debounce is a deliberate trade: a hard kill costs up to ~2 s of typing, verified end to end with `pkill -9` |

## Consequences

- **A hard kill costs at most ~2 seconds of typing.** Measured, not assumed: kill with no
  graceful shutdown, restart, reload, text intact.
- **`File.content` is derived state with exactly one writer** — `materialize.ts`, on the
  flush tick *after* the append succeeds. It may lag the log by one flush interval and must
  never lead it. A failed materialization is logged and dropped: never rolled back, never
  requeued. Compaction never writes it. This is what lets the runner (ADR-004) and the file
  API read plain text without ever loading a CRDT.
- **There is no `PUT` for file content.** Module 4.4 removed it. Text is written through
  the collaboration socket; a REST write would be silently overwritten by the next flush.
- **`attachPersistence` is attached LAST**, after loading and seeding. `Y.applyUpdate`
  fires `ydoc.on('update')`, so attaching earlier appends every update just read out of the
  log straight back into it — the log doubles on every open while the room looks perfectly
  correct. One test catches this (`rooms.test.ts`, *"does not grow the log when a document
  is reopened"*), and it was verified to fail when the ordering is broken.
- **A document seeded from `File.content` writes that state as its initial snapshot
  immediately**, before anything can be typed. Without it the next open finds nothing
  stored, re-seeds, and replays the log on top — the text appears twice.
- **`compact()` is one store method, not `writeSnapshot` + a delete.** A crash between two
  calls in the wrong order is data loss; as one transaction it is a no-op.
- **`persistence` imports nothing from `collab`** — it takes ids and a `Y.Doc`, never a
  `Room`. `buffer.ts` may import `yjs`; a `DocStore` implementation may not, because
  storage stays byte-opaque and swappable.
- **Prisma's `Bytes` is asymmetric** — reads give `Uint8Array<ArrayBuffer>`, writes demand
  it, and Yjs produces `Uint8Array<ArrayBufferLike>`. `toStoredBytes` copies into an
  `ArrayBuffer`-backed view; never call `.buffer` or `.byteOffset` on bytes that came out
  of the store.

### What Phase 8 measured, and what it did not

The 2 s debounce is visible from outside as **~30 `DocUpdate` rows per document per minute
per instance** — each flush merges into a single row
(`docs/notes/loadtest-results.md` §7.4).

Phase 8 never reached compaction at all: `snapshotHighWaterDelta` was **0** in every run,
because each flush merges into one row and 60-second runs never approached the 200-row
threshold.

### What Phase 11 measured

A 300-second, two-instance, one-document run through the same harness **did** reach it —
`snapshots Δ1`, `high-water Δ3539`, the first time compaction has been observed under load.
Afterwards the watermark stood at 3539 with 115 rows left and a lowest surviving id of
**3540**: safe pruning holding exactly, on real data. A cold rebuild from snapshot + tail
gave 6773 characters, identical to `File.content` and to what both clients converged on.

Still unmeasured: compaction's own latency and CPU cost, and log length over a long-lived
document. What is proved by tests rather than by that run is the losing side of the CAS —
two instances flushing every two seconds make an overlap likely, not certain, and none was
directly observed. Detail in `docs/notes/compaction.md`.

## Corrections

`docs/PLAN.md`'s module map (row 4.4) lists "materialize plain text into `File.content`" beside
snapshotting as though the two were separable. **They are not** — materialization rides the
same flush tick as the append, and that ordering is the invariant above. No other claim in
the original text is overtaken.

## See also

- `docs/ARCHITECTURE.md` §4 — the storage path, with the diagram
- `docs/notes/persistence.md` — op log vs snapshot trade-offs
- `docs/notes/compaction.md` — the three cross-instance races, the fixes, the measurements
- ADR-003 — why two instances each run their own copy of all of this, and why the
  at-most-once doc bus is what made Race B real
