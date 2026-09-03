# ADR-003 — Multi-instance transport: Redis Pub/Sub, not Streams, not Kafka

**Status:** Accepted · **Decided:** Phase 7 (2026-08-15) · **Implemented:** modules 7.1–7.2
**Code:** `apps/server/src/modules/redis/docBus.ts` · call sites in `collab/syncHandler.ts`

---

## Context

One server instance holds a `Y.Doc` per open file in memory and fans updates out to the
sockets attached to it. Two instances each hold their own copy of the same document and
know nothing about each other, so two users on different instances edit in parallel
universes.

Something has to carry updates between instances. The question is what delivery guarantee
that something needs.

## Decision

**Redis Pub/Sub, one channel per document** — `doc:<projectId>:<fileId>`.

```
publish = ydoc/awareness observer -> doc:<projectId>:<fileId>
frame   = lib0: instanceId (str) + kind (var: 0 sync, 1 awareness) + payload
receive = own instanceId? drop. else apply with BUS_ORIGIN
sub     = first local join (attachRoomObservers) · unsub = leaveRoom, before the flush
```

**The delivery guarantee needed is at-most-once**, which is what makes Pub/Sub sufficient:
durability already lives in Postgres (ADR-002), and **Yjs self-heals any gap** on the next
sync round-trip. A dropped frame costs a round-trip, not data.

## Alternatives rejected

| Option | Why not |
|---|---|
| **Redis Streams** | Consumer groups and retention buy nothing when the payload is idempotent and self-healing, while adding XADD/XREAD cost and trim management. **Streams are right where at-least-once matters** — reserve them for run-output replay, if a client should ever reattach mid-execution (see ADR-004's limitation) |
| **Kafka** | Operational weight far beyond a single-machine project |
| **Sticky sessions only** | Solves nothing for two users who legitimately land on different instances, and makes the load balancer part of the correctness argument |
| **A single global channel** | Would deliver every keystroke in the system to every instance, whether or not it has the document open (`docBus.ts:57`) |

## Consequences

- **`docBus` knows doc ids, bytes and channels — never `Room`, `Y.Doc` or `Awareness`.**
  Same discipline as `persistence` (ADR-002): ids and bytes in, bytes back through a
  callback. `room.ts` and `syncHandler.ts` import it through the barrel.
- **Local fan-out happens FIRST, the publish second** (`syncHandler.ts:134,137`). A local
  peer's latency must never depend on Redis.
- **Two echo guards, and both are needed.** Redis delivers our own publishes back to our
  own subscriber, so `instanceId` is checked on receive before anything else; and a frame
  applied from the bus carries `BUS_ORIGIN` (`syncHandler.ts:80`), which the observers
  refuse to re-publish. They fail in different directions — keep both.
- **A remote frame is applied, then fans out through the *same* observer.** That is why
  there is no "send this remote update to my sockets" branch. It also means
  `isConnection(origin)` is false for bus frames, which keeps a remote peer's awareness ids
  off our sockets.
- **`unsubscribeDoc` runs synchronously in `leaveRoom`, right after `rooms.delete`, BEFORE
  the final flush is awaited** (`room.ts:178`). That await can take a while; a rejoin
  inside it builds a fresh room subscribing for the same docId, and unsubscribing
  afterwards would tear down the *new* subscription — the document then silently stops
  receiving remote edits for the rest of its life.
- **Both connections are lazy**, and a publisher and a subscriber are separate because a
  connection in subscribe mode cannot issue `PUBLISH`. Importing `docBus.ts` connects to
  nothing, so `buildApp()` stays Redis-free.
- **Six Redis connection roles now exist, and roles never share a connection:** BullMQ
  producer (server, lazy) · one subscriber per run (server) · BullMQ worker (runner,
  blocked) · run publisher (runner) · doc-bus publisher · doc-bus subscriber.
- **Phase 7 added no reconnect logic.** ioredis retries the bus; Phase 5 retries the
  browser. `docBus.ts` has no timer, no backoff and no retry loop. A third reconnect system
  would be the sign something went wrong.

### Measured cost

On the hot-document scenario at 25 clients, a second instance cost **~0.5 ms at the median
and ~3.5 ms at p99** (`docs/notes/loadtest-results.md` §5, R3 − R2). Local fan-out happens
first, so only the cross-instance half of the traffic pays the round trip.

**Two instances persist the same room twice**, which shows up as exactly **2.0× `DocUpdate`
rows** (§5, R4x). That is **write amplification, not corruption** — each instance runs its
own write buffer for its own `Y.Doc`, Yjs converges, and the text is correct. Never assert
row counts as a correctness check in a two-instance test; more rows is the right answer.

### What this decision did not fix

- **Run routing is still single-instance.** The execution registry is in-process, so a
  browser must reach the instance that took its POST; streaming from the other instance is
  a **404**, verified in module 7.2 and recorded rather than fixed. Collaboration tolerates
  at-most-once because Yjs self-heals; run output does not. The fix is sticky routing or a
  Redis-backed registry with replay — this ADR's Streams case, and its own module.
- **Revocation does not cross instances.** Module 3.4b walks *this process's* rooms, so a
  user whose role changed keeps a live socket on the other instance until they disconnect.
  They can reach nothing new — every join and every REST call re-authorizes — but an open
  editor stays open.
- **`INSTANCE_ID` is per process, not per deployment.** Two instances pointed at one Redis
  exchange frames even across different databases.

## Corrections

None. This ADR's original one-paragraph sketch in `docs/PLAN.md` was written before Phase 7 and
survived implementation intact. Two things it did not mention, added above: the
`config.docBusEnabled` flag (default `NODE_ENV !== 'test'`), which gates **only** the two
call sites in `syncHandler.ts` and must not grow a second purpose; and the fact that module
7.2 needed one real code change (`API_PORT` in `vite.config.ts`) rather than being pure
verification.

## See also

- `docs/ARCHITECTURE.md` §3 — the edit path across instances, with the diagram
- `docs/notes/scaling.md` — the pub/sub-vs-streams note and the two-browser results
- ADR-001 — the transport this extends without forking
