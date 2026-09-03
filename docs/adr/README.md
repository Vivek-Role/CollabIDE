# Architecture Decision Records

The five decisions that shaped this project: what was chosen, why, what was rejected, and
what it cost. **These files are canonical.** `docs/PLAN.md` contains the original
one-paragraph sketches of them and now points here; where the two differ, these files are
right, and each one says so in its **Corrections** section.

Each ADR follows the same shape — *Context · Decision · Alternatives rejected ·
Consequences · Corrections* — and is short on purpose. The long-form reasoning lives in
`docs/plans/` (per-module plans and phase summaries) and `docs/notes/` (the learning notes
and the measured results); the ADRs link out to both.

| ADR | Decision | Status |
|---|---|---|
| [ADR-001](ADR-001-yjs-transport.md) | **Yjs transport:** a hand-rolled `y-protocols` WebSocket server, not `y-websocket`'s bundled server and not Hocuspocus — because auth, per-document authorization, persistence and cross-instance fan-out all need a seam those hide | ✅ Accepted · **corrected** |
| [ADR-002](ADR-002-persistence-op-log.md) | **Persistence:** an append-only log of Yjs binary updates, periodic snapshots and compaction, behind a swappable `DocStore` — not a whole-document write per change, and never plain text | ✅ Accepted · **corrected** |
| [ADR-003](ADR-003-multi-instance-pubsub.md) | **Multi-instance transport:** Redis Pub/Sub, one channel per document — not Streams, not Kafka — because durability is Postgres's job and gap repair is Yjs's | ✅ Accepted |
| [ADR-004](ADR-004-execution-queue-worker.md) | **Execution:** a BullMQ queue and a separate runner process that solely owns the Docker socket — never in-process, never an external service | ✅ Accepted · **corrected** |
| [ADR-005](ADR-005-files-into-container.md) | **Files into the container:** `docker create` → `docker cp` → `docker start -a` with a **volume-backed `/work`**, not bind mounts | ✅ Accepted · **corrected** |

## Status legend

| Status | Meaning |
|---|---|
| ✅ **Accepted** | In force, and the code matches it |
| **corrected** | Accepted, but the *original* text in `docs/PLAN.md` said something that implementation overtook. The ADR's **Corrections** section names exactly what and why |
| ~~Superseded~~ | Replaced by a later ADR. None yet |

## The corrections, in one place

Four of the five carry a correction. Three of them matter enough to repeat here, because
each is a claim a reader could otherwise carry away as true:

1. **The collaboration WebSocket is authenticated by the session cookie, not a
   query-parameter token** (ADR-001). `docs/PLAN.md`'s module map (row 3.2) says query
   param; it was deliberately never built. A token in a URL lands in proxy logs and
   `Referer` headers.
2. **Run output is Server-Sent Events, not the collaboration WebSocket** (ADR-004).
   `docs/PLAN.md`'s module map (row 6.6) says otherwise. That socket is per-document; a
   run is per-project.
3. **`/work` must be a volume** (ADR-005). A read-only rootfs refuses `docker cp` outright.
   And the two failing workarounds fail *differently*: `--tmpfs /work` is refused like the
   rootfs, while a **tmpfs-backed named volume** accepts the copy and silently discards it.

The fourth (ADR-002) is smaller: `File.content` materialization is not separable from the
flush cycle — it rides the same tick.

## Reading order

New to the system? `docs/ARCHITECTURE.md` first — it is the map, and it links back here at
each decision point. These files answer *why*, not *what*.
