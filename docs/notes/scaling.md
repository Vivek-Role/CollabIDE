# Phase 7 — Horizontal scaling: results and delivery semantics

**Date:** 2026-08-14 / 2026-08-15 · **Machine:** WSL2 Ubuntu 26.04 on Windows 11,
i7-13620H, 15.7 GB RAM · **Branch:** `feat/redis-scaling` from `e197f39`
**Stack under test:** two `@collab/server` instances, two Vite dev servers, one
runner, one Redis 7, one PostgreSQL 16.

This note does two jobs: it records what two instances actually did, and it
explains why the transport between them is Pub/Sub rather than Streams. Same
rule as `sandbox-tests.md` — **observed output only, nothing predicted.**

---

## How it was run

```bash
docker compose -f infra/docker-compose.yml up -d      # postgres + redis

npm run dev:server      # instance A — :4000, WEB_ORIGIN=http://localhost:5173
npm run dev:web         # browser A  — :5173, proxies to :4000 (no env set)

npm run dev:server:b    # instance B — :4001, WEB_ORIGIN=http://localhost:5174
npm run dev:web:b       # browser B  — :5174, API_PORT=4001

npm run dev:runner      # ONE runner, shared by both instances
```

Two accounts with **separate cookie jars** (a normal window and an incognito
window — `SameSite=Strict` does not isolate by port, so two ordinary tabs would
have shared one session): **Alice** as OWNER on `:5173`, **Bob** as EDITOR on
`:5174`, both with `main.py` open in the project *Phase 7 demo*.

---

## Machine-verified, with the evidence

These were checked from the command line before any browser was opened.

| Check | Observed |
|---|---|
| Build after the vite config change | `npm run build` exit **0**; `npm run build:web` exit **0** (only the pre-existing 1.2 MB chunk-size warning) |
| Server suite, Redis **up** | **232 passed** (223 pre-existing + 9 new docBus) |
| Server suite, Redis **down** | 227 passed, 4 docBus integration self-skipped, **1 pre-existing failure** — see *A note on the suite with Redis down* below |
| Log-growth regression | `rooms.test.ts › "does not grow the log when a document is reopened"` **passes** |
| `--port 5174` vs `strictPort: true` | Vite's CLI flag **does** override `port: 5173`; `strictPort` stays in force. No deviation needed |
| Single-instance flow unchanged | Stack A runs on the plain `dev:server`/`dev:web` scripts with **no environment variables set** |
| Each proxy reaches its **own** instance | Decisive control: `POST` through `:5174` carrying `Origin: http://localhost:5173` → **403**, which only instance B (WEB_ORIGIN 5174) would answer. Matching-origin registrations through `:5173` and `:5174` both → **201** |
| Two-instance headless smoke (module 7.1) | `converged=true noDuplication=true`; awareness — A sees `["Alice","Bob"]`, B sees `["Alice","Bob"]`; after closing B's socket, A sees `["Alice"]`. `SMOKE: PASS` |

**Headless smoke detail**, for the record — two `ws` peers, one per instance,
concurrent inserts at offset 0 from both sides:

```
after A typed: A="hello from A\n" B="hello from A\n"
after B typed: A="hello from A\nhello from B\n" B="hello from A\nhello from B\n"
final A="BBBAAAhello from A\nhello from B\n"
final B="BBBAAAhello from A\nhello from B\n"
```

Identical on both instances, and exactly the expected character count — no
duplication.

---

## Browser verification, A–E

Two real browser profiles, driven by the operator. **These results are as
reported by the operator at the keyboard**; the machine-level evidence above was
gathered separately. **All of A–E passed.**

| # | Check | Result |
|---|---|---|
| **A1–A2** | Alice on `:5173`/A and Bob on `:5174`/B, same file — each types, both see both, text identical in both windows | **PASS** |
| **A3** | Simultaneous typing at the same offset does not corrupt the text (`PLAN.md` 3.5's "Done when", now across instances) | **PASS** |
| **A4** | Reload browser B — rebuilds and still matches | **PASS** |
| **B5** | Both carets visible in the other window with the right name and colour | **PASS** |
| **B6** | Moving a cursor in A moves the remote caret in B | **PASS** |
| **B7** | Closing browser B removes its caret from A | **PASS** |
| **C8** | One keystroke inserts exactly one character in both windows | **PASS** |
| **C9** | A pasted paragraph appears once, not twice | **PASS** |
| **C10** | Exactly **two** carets per window — awareness does not multiply | **PASS** |
| **C11** | Reload both browsers — text still correct, still not doubled (catches an echo that only shows after persistence replays it) | **PASS** |
| **D12** | A run started and streamed in the same browser works, unchanged from Phase 6, with the single shared runner | **PASS** |
| **D13** | POST a run through A, request its stream from B → **404** — the known limitation, demonstrated deliberately | **PASS (limitation confirmed)** |
| **E14–E16** | Instance B killed while browser B was connected and editing: browser B shows Phase 5's **"Reconnecting…"**, stays mounted and typeable, no terminal banner; **browser A keeps working normally** | **PASS** |
| **E17** | Instance B restarted → browser B reconnects on the existing backoff and converges with everything A typed while it was down | **PASS (operator-reported)** |
| **E18** | No new reconnect code anywhere in Phase 7 | **PASS — verified mechanically:** `reconnect.ts` and `CollabProvider.ts` are untouched by the Phase 7 diff, and `docBus.ts` contains no timer, no backoff and no retry loop |

**The kill in E14 was a real graceful shutdown**, not a hard kill: instance B
logged `[server] SIGTERM received — shutting down` and went through
`flushAllRooms` → `closeAllRuns` → `closeQueue` → `closeDocBus`. Instance A
answered normally throughout, and the runner was unaffected.

**Q6 is closed.** The two-real-browser-profiles gap, open since Phase 3, was
finally exercised here — and it was exercised across two instances, which is
more than Q6 originally asked for.

### One caveat on E17, recorded rather than glossed

Instance B was stopped by this session and **was not restarted by it** — at the
time this note was written, `:4001` was still down and only `:4000`, `:5173` and
`:5174` were listening. E17's restart-and-converge result is therefore
**operator-reported and not reproduced in the environment state this session can
see.** Everything else in E was directly observed. If E17 was not in fact
exercised, it is a five-minute check: `npm run dev:server:b`, watch browser B go
from *Reconnecting…* to *Live*, and confirm it picked up what A typed meanwhile.

### A note on the suite with Redis down

The suite is Redis-free **except one pre-existing Phase 6 test**:
`execution.test.ts › "allows an EDITOR"` POSTs `/run`, which reaches BullMQ's
lazy `queue.add`. Probed directly against `dist/modules/execution/queue.js` —
importing no collab and no docBus — `queue.add` was **still pending after
5004 ms** with Redis down, so the request never returns and the 5-second test
timeout fires. **Not introduced by Phase 7**, and not fixed by it; the test's own
comment ("Redis may or may not be up… either way it is past every guard") is what
is inaccurate. Worth a small follow-up.

---

## Pub/Sub vs Streams

**Redis Pub/Sub is fire-and-forget.** `PUBLISH` delivers to whoever is subscribed
*at that instant* and keeps no record. A subscriber that is disconnected, slow to
attach, or restarting never learns the message existed. There are no offsets, no
acknowledgements and no replay.

**A Redis Stream is a durable append-only log.** `XADD` appends with an id;
consumers read by offset, or in consumer groups with explicit `XACK`; a reader
that was absent can come back and replay from where it stopped. The cost is real:
`XADD`/`XREAD` traffic, a retention policy, trim management, and consumer-group
bookkeeping that has to be got right.

### Why Pub/Sub is correct for the fan-out we have

Collaboration frames are **ephemeral**, and durability for them already exists
somewhere better:

- The authoritative history is the **`DocUpdate` log in PostgreSQL** (Phase 4).
  Redis is a transport here, never a store.
- **Yjs repairs gaps by itself.** A dropped frame costs exactly one state-vector
  exchange on the next sync — which the client performs on every reconnect
  anyway. There is no state that only the bus knows.
- So a durable bus would be paying twice for a guarantee we already have, and
  adding trim/retention operations to a project that currently has none.

This is **ADR-003**, and Phase 7 is where it stopped being a prediction: two
instances ran on Pub/Sub, converged in both directions, and duplicated nothing
(A, C above).

### Why Streams stay deferred

Streams become the right tool the moment somebody must read **what they were not
present for**. Three concrete cases, all already on the books:

1. **Reattaching to a run after a reload.** Today the output is gone — Pub/Sub
   delivered it to a subscriber that no longer exists.
2. **Execution history.** Same shape: replay of something that already finished.
3. **Cross-instance run routing.** The stream would have to survive the gap
   between the POST landing on instance A and the SSE request landing on B.

The strongest signal is that we have already hand-rolled a miniature Stream:
the execution registry's **in-memory frame buffer**, which exists precisely so a
late subscriber can be replayed the beginning of a run. That is a single-process
Stream with a 2-minute TTL. When it needs to work across instances, it should
become a real one rather than grow.

**Nothing in Phase 7 forecloses that.** The doc bus is per-document ephemeral
fan-out and is complete; a run bus would be a separate channel with separate
delivery semantics, which is exactly what ADR-003 anticipated.

---

## Limitations this configuration has, measured or observed

- **Run routing is single-instance.** POST to A, stream from B → **404**
  (D13, observed). A browser must reach the instance that accepted its POST;
  without a load balancer that is what naturally happens. Fixing it needs sticky
  routing or a Redis-backed registry with replay.
- **Cross-instance revocation does not cross instances.** `disconnectProject`
  and `disconnectProjectUser` (module 3.4b) walk **this process's** rooms only, so
  a user removed from a project keeps a live socket on the *other* instance until
  they disconnect. Authorization still runs at every join and on every REST call,
  so they cannot re-enter or reach anything new — but an open editor stays open.
  A revocation channel on the same bus would fix it; that is a design change
  Phase 7 deliberately did not make.
- **Both instances hold the same room and both persist it.** Each has its own
  `Y.Doc`, write buffer and flush cycle, so a document open on two instances
  writes **more `DocUpdate` rows** than one would. Yjs converges and the text is
  correct — this is write amplification, not corruption. Row counts were
  deliberately **not** asserted anywhere in this verification, because more rows
  is the *correct* behaviour here. Compaction still assumes a single writer
  (recorded since Phase 4).
- **`INSTANCE_ID` is per process, not per deployment.** Two instances pointed at
  one Redis exchange frames even if they use different PostgreSQL databases.
  Not a defect at this scale, stated so nobody is surprised.
- **The doc bus is at-most-once**, by the reasoning above.
- **No metrics.** Cross-instance propagation latency was not measured — Phase 8
  measures, and only measured numbers go in docs.
