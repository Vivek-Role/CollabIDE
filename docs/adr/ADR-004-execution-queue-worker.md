# ADR-004 — Execution: a BullMQ queue and a separate runner process

**Status:** Accepted · **Decided:** Phase 6 (2026-08-14) · **Implemented:** modules 6.1–6.7
**Code:** `apps/runner/` · `apps/server/src/modules/execution/` · `packages/shared/src/languages.ts`

---

## Context

Clicking **Run** has to execute code the user wrote, on our machine, and stream the output
back to their browser. Two things are non-negotiable: user code must never run in the
process that serves everyone's requests, and access to the Docker socket is effectively
root on the host.

## Decision

**A BullMQ queue on Redis, and a separate `apps/runner` process that solely owns the Docker
socket.**

```
click Run -> POST /api/projects/:id/run        EDITOR · 202 { jobId }
             flushAllRooms() -> read File.content -> cap 1MB/100 files
             registry.open (SUBSCRIBE) -> queue.add attempts:1
          -> GET  /api/projects/:id/runs/:jobId/stream    SSE, re-authorized
runner    -> BullMQ Worker concurrency 2 -> runWithLimits -> runInContainer
          -> PUBLISH run:<jobId>  {stdout|stderr|exit}
```

Adding a language is one config entry in `packages/shared/src/languages.ts` — `{id, image,
cmd, extensions}` — and zero code changes. Two exist: `collab-sandbox-python:1` and
`collab-sandbox-node:1`, pinned to a major version, never `:latest`.

## Alternatives rejected

| Option | Why not |
|---|---|
| **Run in the server process** | Violates the hard rule that user code never executes in the backend, and one runaway job stalls the event loop for every connected user |
| **An external execution service** (Judge0 and similar) | The sandbox *is* the interesting part of this phase. Outsourcing it removes the thing being built |
| **A direct HTTP call from server to runner** | Would couple the two processes and put backpressure management in the wrong place. The queue gives concurrency limits and a natural buffer for free |
| **Forwarding output over the collaboration WebSocket** | See *Corrections* |

## Consequences

- **The runner is the sole owner of the Docker socket.** `apps/server` imports no Docker
  anything and nothing from `apps/runner`; the runner imports no Prisma, no Yjs, no
  Express, no `ws`. They share only `@collab/shared` types, the BullMQ queue and Redis
  channels. Root-equivalent access lives in a process that serves no HTTP.
- **`runInContainer` is the entire sandbox interface** — one function, one file
  (`sandbox/docker.ts`). Container pools, a different runtime or a remote executor all
  replace exactly it. The driver **reports facts and interprets nothing**; `limits.ts` one
  layer up decides what a `RunStatus` is.
- **A run is bounded, so nothing about it retries.** `attempts: 1` (`service.ts:82`); the
  client never reconnects a stream. This is what stops a second reconnect system appearing
  beside Phase 5's.
- **Exactly one `exit` frame ends every run, on every path**, published from a `finally`
  behind a `terminalSent` guard. Without it the browser spins forever. The worker **never
  throws for an execution result**, including `error` — the frame is the single
  execution-result channel, and BullMQ job state is not a health signal.
- **The server subscribes BEFORE it enqueues.** Pub/Sub is at-most-once and a fast program
  finishes in ~300 ms, so a subscription opened when the SSE request arrives would miss the
  whole run. The registry also keeps a terminal entry alive until a client drains it —
  deleting on the terminal frame threw away exactly the output a late subscriber came for
  (the 6.6 bug).
- **The BullMQ `Queue` in the server is a lazy singleton.** A `new Queue()` at import time
  would open Redis connections inside all the pre-existing tests, which call `buildApp()`
  directly.
- **Limits, in one place:** 10 s wall clock (`RUN_TIMEOUT_MS`), 1 MB output cap
  (`MAX_OUTPUT_BYTES`), 100 files / 1 MB of input, worker concurrency 2, 20 concurrent
  registry entries (`MAX_ACTIVE_RUNS`), 120 s entry TTL. **Exit 137 is ambiguous** — a
  kernel OOM and our own `docker kill` both produce it — so `RunResult.killed` is the only
  thing that separates them, which is why `--rm` can stay and no `docker inspect` is needed.
- **The reaper filters `label=ce.run` and nothing else**, only removes containers older
  than 60 s, and uses `docker rm -fv`. `docker container prune` leaves volumes behind and
  **`docker volume prune` is forbidden** — ours are anonymous, so a prune would delete
  unrelated user volumes.

### Known limitations

- **Run routing is single-instance** (see ADR-003). The registry is in memory on the
  instance that accepted the POST; streaming from another instance is a **404**.
- **A stream aborted mid-run holds its registry slot until the 120 s TTL**, so the
  effective cap is "20 minus recently-abandoned runs".
- **A run does not include unsynced edits.** Running is server-side; `flushAllRooms()`
  only guarantees freshness for what the server already has.
- **No reattaching after a reload**, no execution history, no stdin, no cancellation, no
  per-user quotas. Concurrency 2 plus the 20-entry cap is the only backpressure.
- **The Run path was never load-tested.** Phase 8 measured collaboration only.

## Corrections

**`docs/PLAN.md`'s module map (row 6.6) says run output is forwarded "over the user's
existing WS". It is not — it is Server-Sent Events.**

`GET /api/projects/:projectId/runs/:jobId/stream`, re-authorized on connect
(`execution/routes.ts:35`, `execution/stream.ts:23`). The collaboration socket is
**per-document** while a run is **per-project**, so there was no principled answer to which
open file's connection should carry the output. SSE is one-directional server-to-client
text, which is exactly the shape of this problem.

Consequences worth stating, because they are easy to get wrong:

- **`MessageType`, `CollabProvider.ts` and `reconnect.ts` are untouched by Phase 6 and must
  stay that way.** Run output never enters the collaboration protocol.
- **The two client URLs differ**: `api.post('/projects/:id/run')` — `api.ts` prepends
  `/api` — and `new EventSource('/api/projects/:id/runs/:jobId/stream')`, which does not.
- EventSource's own auto-reconnect is suppressed client-side, because a bounded run must
  not acquire a retry loop.

`docs/PLAN.md`'s module map (row 6.1) also lists a `filename` field on the language config. It
was **dropped**: files are copied at their real project-relative paths and the entrypoint
runs at its own path, so nothing would ever have read it.

## See also

- `docs/ARCHITECTURE.md` §5 — the run path, with the diagram
- ADR-005 — how the files actually get into the container
- `docs/notes/sandbox.md` — cgroups, namespaces, capabilities
- `docs/notes/sandbox-tests.md` — the six safety results
