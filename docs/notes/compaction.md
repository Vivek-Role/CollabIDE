# Compaction across two instances — how it is made safe, and what was measured

Working notes from Phase 11 (modules 11.1–11.3). Companion to
`docs/notes/persistence.md`, which covers op-log-vs-snapshot in general; this
file is only about **compaction with more than one writer on the log**.

Phase 4 shipped compaction. Phase 7 gave the system a second server instance and
made Phase 4's central assumption false. Phase 11 is the repair.

---

## What was wrong

Phase 4's compaction did this, from inside the buffer's flush chain:

```
appendedId = store.appendUpdate(...)          # the row this flush just wrote
if countUpdates(docId) > 200:
    store.compact(docId, Y.encodeStateAsUpdate(room.ydoc), appendedId)
                        # ^ THIS instance's document      ^ THIS instance's row id
```

and the safety argument, written out in `compactor.ts`, was: *the live `Y.Doc`
holds everything ever applied to it, so the snapshot covers every row up to
`appendedId`, and deleting exactly those rows loses nothing.*

That argument holds for **one** writer. It is false for two, in three separate
ways. All three are silent — none produces an error anywhere.

| | Failure | Mechanism |
|---|---|---|
| **B** | An update written by the other instance is destroyed | The snapshot comes from *our* `Y.Doc`. The doc bus is at-most-once (ADR-003), so a row the other instance appended may never have reached us. We delete it anyway, holding no copy of what was in it. |
| **C** | A row survives the delete and is then invisible forever | `DocUpdate.id` is a sequence value, and a sequence value is allocated **before** its transaction commits. A row with a *lower* id can become visible after compaction has read past it. Postgres cannot delete a row the deleting statement cannot see, so it survives — and then sits below `DocSnapshot.updateId`, where `load`'s `id > updateId` filter hides it permanently. |
| **D** | Two compactors overwrite each other | A folds through 100, B folds through 150 and deletes 101–150, then A's `upsert` puts the watermark back to 100 — with the rows between them already gone. |

## The three fixes

Each closes exactly one row of that table. They are independent and all three are
needed.

**1. The boundary comes from the log, not from us** (module 11.1).
`readForCompaction(docId, cutoff)` returns the eligible rows, the highest id
among them, and the snapshot they sit on. Nothing about the boundary is derived
from what this process has in memory.

**2. A 30-second age cutoff** (module 11.1). `readForCompaction` will not return
a row whose `createdAt` is inside `COMPACT_LAG_MS = 30_000`. This is what closes
C: an in-flight append cannot be older than the cutoff, so the watermark can
never be set above a row that is still committing. An append is a single
statement, so the gap between its `createdAt` and its commit is microseconds —
thirty seconds is roughly six orders of magnitude of headroom.

*This is a margin, not a proof.* It assumes an append never stalls between
timestamp and commit for half a minute. The cost is that the newest few rows of
a document are never folded, which is irrelevant against a 200-row threshold.

**3. Compare-and-set on `DocSnapshot.updateId`** (module 11.1). `compact` takes
`expectedUpdateId` and writes only if the stored watermark is still that value;
the delete runs **only** after the CAS has won. `false` from `compact` is a
guarantee that nothing was written *and* nothing was deleted. Where there is no
snapshot yet, the unique index on `docId` is the CAS and P2002 is caught as a
lost race. That closes D.

**4. The snapshot is folded from the persisted updates** (module 11.2).

```ts
const folded = new Y.Doc();
if (candidate.snapshot) Y.applyUpdate(folded, candidate.snapshot);
for (const update of candidate.updates) Y.applyUpdate(folded, update);
return Y.encodeStateAsUpdate(folded);
```

The bytes deleted are exactly the bytes folded, so the snapshot covers them by
construction — whoever wrote them, and whether or not this process ever saw
them. That closes B, and it is why `maybeCompact` no longer takes a `Y.Doc` at
all: **compaction is now independent of any live room.**

A throwaway `Y.Doc` rather than `Y.mergeUpdates`, deliberately: merging
concatenates update payloads without collecting deleted content, so the snapshot
would grow with the document's edit *history* instead of its size. Applying and
re-encoding also makes the fold a pure function of the log, so both instances
compute identical bytes from identical rows.

### What did *not* change

`load()` is untouched — still `latest DocSnapshot + every DocUpdate with a
greater id`. `writeSnapshot` still owns the seed path and still deletes nothing.
The delete predicate is still `id <= throughUpdateId`. The flush chain, the
2 s/64 KB triggers, `COMPACT_AFTER = 200`, and compaction's best-effort
semantics are all as Phase 4 left them. No schema migration; no new dependency.

## Safe pruning, stated once

> Every row at or below `DocSnapshot.updateId` is folded into the snapshot and
> deleted. Every row above it survives and is replayed by `load`. There is no
> third case.

C was a violation of the second half; B was a violation of the first.

---

## Verification

### In the suite — `apps/server/test/compaction.test.ts`

Three cases, each modelling two instances as two independent `Y.Doc`s over one
`docId`, neither ever receiving the other's updates:

1. *preserves the other instance's updates through a compaction* — B's row is
   inside the boundary A deletes; after the fold, a cold rebuild still contains
   B's text.
2. *lets only one of two racing compactors win, and loses nothing* — both read
   the same candidate and the same CAS token, then `compact` concurrently.
   Exactly one returns true, one snapshot row exists, the log is pruned once.
3. *reconstructs the same document whichever instance folded it* — the fold is
   byte-identical from either side.

`rooms.test.ts` carries the end-to-end version, *folds updates this instance
never saw*, which drives the real flush chain. It was **verified to fail when
the fold is broken**: with the `applyUpdate` loop removed it reports
`expected '' to contain 'remote'`.

### Two real instances, one database

Two built server processes (`node apps/server/dist/index.js`) on ports 4002 and
4003 against the same PostgreSQL database, driven by the existing Phase 8
harness — no new infrastructure:

```
npm run loadtest -- --clients 2 --docs 1 \
  --servers http://localhost:4002,http://localhost:4003 \
  --duration 300 --warmup 20 --edits-per-sec 3 --scenario distributed \
  --database-url postgresql://collab:***@localhost:5432/collab_editor
```

`--docs 1` with `--servers` ×2 is the topology that matters: clients map to docs
by `i % docs` and to servers by `i % servers`, so both clients share one document
across two instances (CLAUDE.md's coprime warning, satisfied here by one doc).

Ports 4002/4003 rather than 4000/4001 only because an unrelated process held
4000 on this machine. Date 2026-09-02, git `b8e9e25-dirty`, node v22.23.2,
4 CPUs.

**Harness result — PASS**

```
doc  cmtjnnida0001io7ha5ixd5n8:cmtjnnieq0003io7hrrc0xk8w
clients 2  expected 6773  actual 6773  converged yes

latency p50=5.0 p95=8.0 p99=13.0 ms  n=280  docsWithNoPeer=0
db   0.4 DocUpdate rows/sec (Δ115, snapshots Δ1, high-water Δ3539)
```

`snapshots Δ1` and `high-water Δ3539` are the point: **compaction actually fired
during a two-instance run**, which no Phase 8 run ever achieved (they all
reported a high-water delta of 0, never reaching the threshold in 60 seconds).

**Database state afterwards**

```
docId                                              watermark  rows_left  min_id_left  snap_bytes
cmtjnnida0001io7ha5ixd5n8:cmtjnnieq0003io7hrrc0xk8w     3539        115         3540       24973
```

`min_id_left = watermark + 1` is the safe-pruning invariant holding on real
data: nothing at or below the watermark survived, and nothing above it was
touched. A Race C orphan would appear here as a surviving row id **below** 3539.

**Cold rebuild** — snapshot + the 115 surviving rows, in a fresh `Y.Doc`:

```
snapshot bytes 24973   tail rows 115
cold rebuild len 6773   File.content len 6773   identical true
```

6773 characters is exactly what the harness independently expected and what both
clients converged on, and the cold rebuild is byte-identical to the materialized
`File.content`.

### What this does and does not establish

It establishes that compaction fires under two instances, prunes safely, and
reconstructs correctly afterwards.

It does **not** establish that a genuinely simultaneous compaction of one
document by two instances occurred during that run — the CAS path is proved by
the suite, not by this run. Two instances flushing the same document every two
seconds makes an overlap likely rather than certain, and nothing here observed
one directly. That is a limit of the observation, not a known gap: the losing
path is deterministic and tested.

## See also

- `docs/adr/ADR-002-persistence-op-log.md` — the decision, amended in 11.3
- `docs/notes/persistence.md` — op log vs snapshots in general
- ADR-003 — why the doc bus is at-most-once, which is what makes Race B real
- `docs/notes/loadtest-results.md` — the harness, and Phase 8's numbers
