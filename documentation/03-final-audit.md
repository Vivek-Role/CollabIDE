# Phase 4A — Final technical audit & runtime verification

**Date:** 2026-09-03 · **Branch:** `feat/docs-architecture` · **HEAD:** `590d900`
**Scope:** audit and runtime verification only. No viva material. No application code changed.

---

## 1. Method and environment

| | |
|---|---|
| Host | WSL2 Ubuntu, Node v24.19.0, Docker Desktop |
| Database | `collab-postgres` (`postgres:16-alpine`), healthy |
| Redis | `collab-redis` (`redis:7-alpine`), healthy |
| Server under test | **A clean forced rebuild** (`npx tsc -b --force`) of `590d900` + working tree, run as `node apps/server/dist/index.js` on ports **4002** and **4003** — isolated from the user's own instances on 4000/4001 |
| Runner | The user's already-running `npm run dev:runner` (tsx, current source) |
| Sandbox images | `collab-sandbox-python:1`, `collab-sandbox-node:1`, pre-built |

**How the tests were driven.** Three temporary ES-module scripts under `.audit-tmp/`, written to
drive the system exactly as a browser does — REST via `fetch`, collaboration via a real
`ws` + `yjs` + `y-protocols` client, run output via `EventSource`-shaped SSE reads. Protocol
constants (`/ws`, `doc`, `content`, message type `0`) were **hardcoded rather than imported from
`@collab/shared`**, so the tests check *against* the documented contract instead of restating it.
**`.audit-tmp/` has been deleted**; nothing was added to the repository.

**Two facts about the environment that matter for reading the results:**

- The user's `:4000` instance was running a **stale build dated Aug 14**, predating Phase 11.
  All verification below used a fresh forced rebuild instead.
- **Two `npm run dev:runner` processes are running simultaneously**, so effective execution
  concurrency was 4 containers, not the documented 2. This does not invalidate any result below
  (nothing measured throughput), but it is worth knowing.

---

## 2. Verified behaviour

Everything in this section was **observed by executing it** on 2026-09-03.

### 2.1 Build, migrations, tests

| Check | Result |
|---|---|
| `npx tsc -b --force` | Clean, exit 0 |
| `npx prisma migrate status` | "Database schema is up to date", **2 migrations found** |
| `npm test` | **245 tests / 13 files, all passing** (re-run after the forced rebuild) |
| `npm run build:web` | Succeeds in 1.04 s — initial JS **315.56 kB** (98.49 kB gzip), lazy `ProjectPage` **923.14 kB** |
| Server startup | Boots and serves `GET /health` → `200 {"ok":true}` |

### 2.2 REST API — matches [API.md](../docs/API.md) exactly

| Case | Observed |
|---|---|
| `GET /health` | `200 {"ok":true}` |
| `GET /api/auth/me`, `/api/projects` without cookie | `401 UNAUTHENTICATED` |
| Unknown route | `404 NOT_FOUND` |
| Register valid | `201` + `ce_session` cookie |
| Register duplicate email | `409 EMAIL_TAKEN` |
| Register 9-char password | `400 VALIDATION_ERROR` |
| Login wrong password | `401 INVALID_CREDENTIALS` |
| Login unknown email | `401 INVALID_CREDENTIALS` — **identical code and body** |
| `POST` with `Origin: http://evil.com` | `403 BAD_ORIGIN` |
| `POST` with `Origin: http://localhost:5173` | `201` |
| **`GET` with `Origin: http://evil.com`** | **`200`** — confirms `originCheck` guards mutating methods only |
| Empty project name | `400 VALIDATION_ERROR` |
| Duplicate file path | `409 PATH_EXISTS` |
| Path `../escape.py`, `/abs.py`, `a\b.py` | `400 INVALID_PATH` (all three) |
| `GET` a directory's content | `400` (`IS_DIRECTORY`) |
| **`PUT` on a file** | `404 NOT_FOUND` — the route genuinely does not exist |

### 2.3 Authorization — 404 vs 403 confirmed on every surface

| Case | Observed |
|---|---|
| Non-member `GET /api/projects/:id` | `404 PROJECT_NOT_FOUND` |
| Non-member `GET .../files` | `404 PROJECT_NOT_FOUND` |
| Non-member `POST .../run` | `404 PROJECT_NOT_FOUND` |
| **Wholly non-existent project id** | `404 PROJECT_NOT_FOUND` — **byte-identical to the above** |
| VIEWER `GET` project / files | `200` |
| VIEWER `POST` file | `403 FORBIDDEN` |
| VIEWER `PATCH` project | `403 FORBIDDEN` |
| VIEWER `POST /run` | `403 FORBIDDEN` |
| VIEWER `DELETE` project | `403 FORBIDDEN` |
| Owner removes self | `409 CANNOT_REMOVE_SELF` |
| Demote the last owner | `409 LAST_OWNER` |
| Add member by unknown email | `404 USER_NOT_FOUND` |
| Add member with role `SUPERUSER` | `400 VALIDATION_ERROR` |

**Project existence privacy is real:** a non-member and a non-existent project are
indistinguishable across REST *and* the WebSocket.

### 2.4 Login timing equalisation — measured

Ten samples each, same server, same connection:

```
wrong password : 97 156 95 105 89 90 102 92 96 88   ms   → median 95.5
unknown email  : 93  89 90  94 92 90  91 93 93 91   ms   → median 91.5
```

**Median difference ≈ 4 ms (~4%), distributions overlapping.** The equaliser works at this
resolution. As documented, this is a timing *equaliser*, not a formal constant-time guarantee —
and note the unknown-email path is very slightly *faster* and much *tighter* in spread.

### 2.5 WebSocket authentication and authorization

| Case | Observed close code |
|---|---|
| No cookie | **4401** "Authentication required" |
| Garbage cookie | **4401** |
| Valid cookie, member | **synced** |
| Missing `?doc` | **4400** "Malformed request" |
| Malformed docId (no colon) | **4400** |
| docId with illegal characters | **4400** |
| **`Origin: http://evil.com`** | **4400** |
| `Origin: http://localhost:5173` | synced |
| **No `Origin` header at all** | **synced** — confirms the documented gap |
| Non-member, real document | **4404** "Document not found" |
| Member, non-existent fileId | **4404** |
| **fileId from a different project** | **4404** — the `projectId` half is genuinely enforced |
| **docId pointing at a directory** | **4404** |

**Knowing a document id is not sufficient to join — verified.**

### 2.6 VIEWER read-only enforcement — verified server-side

A VIEWER connected, synced, and inserted text. Result:

- The VIEWER's **own** `Y.Doc` showed `"VIEWER-TEXT;OWNER-TEXT;"` (optimistic local echo).
- The **server's** text remained `"OWNER-TEXT;"`.
- A third session re-reading from the server saw `"OWNER-TEXT;"`.
- Server log: `[collab] dropped a write from wv…@ex.com (VIEWER)` ×3.

**The write was dropped server-side, exactly as documented.** The UI's disabled editor is indeed
"a courtesy"; this is the control.

### 2.7 Live revocation

An OWNER removed a VIEWER while the VIEWER held an open socket:

- The socket closed with **4409** "Document is no longer available".
- The removed VIEWER's subsequent rejoin attempt closed with **4404**.

### 2.8 Persistence, end to end

| Check | Observed |
|---|---|
| Type over WS → wait 3.5 s → `GET .../files/:id` | `File.content` **exactly** matched the typed text |
| Close all sockets, reopen the document (cold load from the log) | Text identical, **no duplication** |

This exercises the flush cycle, `File.content` materialization, the seed-snapshot rule and the
"`attachPersistence` attached LAST" invariant in one path.

### 2.9 Two clients, one instance

Two concurrent sessions typing into the same document converged to
`"AAAOWNER-TEXT;BBB"` on both clients and on the server.

### 2.10 Two instances — the Redis doc bus

Client A on `:4002`, client B on `:4003`, same document:

| Trial | A→B | B→A | A→B (2nd) | Converged | `File.content` after close |
|---|---|---|---|---|---|
| No settle delay | **41 ms** | **41 ms** | **41 ms** | **yes** | correct |
| 1500 ms settle | **41 ms** | **41 ms** | **40 ms** | **yes** | correct |
| Repair trial | **41 ms** | — | — | — | — |

**Cross-instance collaboration verified working, ~41 ms propagation.** See §4.1 for a
non-reproducing failure observed once under load.

### 2.11 Sandbox execution — every documented control observed

| Test | Observed |
|---|---|
| `print('hello from sandbox')` | `status=ok exit=0` 434 ms |
| `console.log(...)` (JS) | `status=ok exit=0` 805 ms, `v24.19.0` — second language works |
| `notes.txt` | `400 LANGUAGE_UNSUPPORTED`, no job created |
| **User privileges** | `uid 1000 gid 1000` — **non-root confirmed** |
| **Network** | `network blocked: OSError` to `1.1.1.1:53` — **no egress** |
| **Root filesystem** | `OSError [Errno 30] Read-only file system: '/rootwrite'` |
| **`/work`** | Writable — wrote and stat'd 1000 bytes |
| **Environment leakage** | `secret-ish env keys: none`. Full env is only `GPG_KEY, HOME, HOSTNAME, LC_CTYPE, PATH, PYTHONDONTWRITEBYTECODE, PYTHON_*` — **no `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` or `POSTGRES_*`** |
| **Docker socket** | `/var/run/docker.sock exists: False` |
| **Memory** | 1 GB allocation → `status=ok exit=137`, `"allocated 1GB"` **never printed**, host unaffected |
| **Output cap** | `status=ok exit=null truncated=true`, **exactly 1,000,000 bytes** delivered |
| **Timeout** | `status=timeout exit=null` after **9,953 ms** |
| **Cleanup** | After ~14 runs including two kills: **0** `ce.run` containers, **0** dangling volumes |

### 2.12 Execution caps and failure paths

| Case | Observed |
|---|---|
| 24 sequential `POST /run` with no stream attached | **exactly 20 × `202`, then 4 × `429 TOO_MANY_RUNS`** |
| Project with 101 files | `413 RUN_TOO_LARGE` — *"This project has 101 files; a run allows at most 100."* |
| Non-member `POST /run` | `404 PROJECT_NOT_FOUND` |
| Valid `jobId` replayed against a **different project** | `404` |
| Unknown `jobId` | `404` |
| **Run started on `:4002`, stream requested from `:4003`** | **`404`** |
| Same run, stream requested from `:4002` | `200` |

The single-instance run-routing limitation is **confirmed by observation**, not just by reading.

---

## 3. Manually pending — NOT verified, awaiting your result

I did not drive a browser. The following cannot be marked verified until you run them and report
back. Each is a complete procedure.

### T1 — Offline editing and reconnection

1. Start `npm run dev:server`, `npm run dev:web`, and log in at <http://localhost:5173>.
2. Open a project and open `main.py`.
3. Type a distinctive line, e.g. `# ONLINE-EDIT`.
4. DevTools → Network → tick **Offline**.
5. Type a second distinctive line, e.g. `# OFFLINE-EDIT`. **Report: does the editor still accept
   typing, and what does the status line say?**
6. Untick **Offline**.
7. **Report:** does the status line return to *Live*, and are **both** lines present with no
   duplication?
8. Reload the page. **Report:** are both lines still there?

### T2 — Two clients, live cursors, convergence

1. Open the same project file in two different browser **profiles**, as `demo@example.com` and
   `alex@example.com`.
2. Type in both at once, then both at the **same character offset**.
3. **Report:** do you see the other user's caret with their name and colour, does text converge
   identically in both windows, and is any text duplicated?
4. Close one window. **Report:** does the other user's caret disappear promptly?

### T3 — Two instances in the browser

1. Run `npm run dev:server` + `npm run dev:web`, and `npm run dev:server:b` + `npm run dev:web:b`.
2. Open the same file at `:5173` and at `:5174` as two different accounts.
3. Type in both. **Report:** do edits and carets cross?
4. In the `:5174` window click **Run**. **Report:** what happens? (Expected from §2.12: the run
   is accepted by whichever server that browser reaches; the failure mode only appears if a
   browser reaches the *other* instance.)

### T4 — Run with the runner stopped (the §4.2 gap)

1. Stop **all** `dev:runner` processes (there are currently **two** running).
2. Click **Run** on any file.
3. **Report:** does the terminal show anything at all, does it spin indefinitely, and is there any
   error after ~2 minutes? *(Code reading predicts: it waits forever with no message.)*

### T5 — Revocation while editing, in the browser

1. Two profiles in the same project; profile B is a VIEWER with the file open.
2. As OWNER, remove B from the project.
3. **Report:** what does B's window show, and can B still type?

### T6 — Small-viewport layout and the search palette

1. Resize the browser to < 768 px wide.
2. **Report:** does the sidebar collapse and slide, and do `Ctrl/Cmd+K` and the tree filter work?

*(This has been user-verified before, in Phase 10, for layout only — never for search.)*

---

## 4. Discrepancies found

### 4.1 One doc-bus frame was lost, once, and was never repaired

**Observed.** In the first two-instance trial — run immediately after 24 run-enqueues and 101
file creations on the same event loop — client A's first edit **never reached** client B (>5 s),
while B's edit reached A in 52 ms. The documents did not converge, and `File.content` ended
holding only B's text. **A's edit was lost from the materialized content.**

**Not reproducible in isolation.** Three subsequent trials on quiet servers, with and without a
settle delay, all propagated in ~41 ms and converged.

**Most likely cause, from code reading (`modules/redis/docBus.ts`):** `subscribeDoc` calls
`getSubscriber().subscribe(channel).catch(…)` and **does not await the acknowledgement**.
`attachRoomObservers` returns immediately, so there is a window between "room is joined and can
receive local edits" and "Redis has actually registered the subscription". Pub/Sub is
at-most-once, so anything published in that window is gone.

**Why nothing repaired it:** the documentation says gap repair is Yjs's job. That is true only
across a **re-sync** — i.e. a reconnect. While both sockets stay open, no further sync round-trip
occurs, so a dropped bus frame is **permanently lost** to the other instance. This is a real
correction to make (see §6.2).

**Severity:** low frequency, but it is silent data divergence between instances. It is a
consequence of the accepted at-most-once design (ADR-003), not a coding error — but the
un-awaited `subscribe` widens the window unnecessarily.

### 4.2 A run with no runner never terminates the SSE stream

**Confirmed by code reading, not reproduced** (I did not stop the user's runners).
`registry.remove()` clears the entry and its timer but **never calls `res.end()`**, and
`stream.ts` ends the response only on an `exit` frame. So when nothing consumes the queue, the
120 s TTL silently drops the entry while the browser's stream stays open forever.

This was already documented in Phase 3 with that exact caveat. **T4 above would confirm it.**

### 4.3 Close code 4400 is under-documented

An `Origin` mismatch on the WebSocket upgrade closes with **4400** (`wsServer.ts:80`) — verified
at runtime. Every close-code table describes 4400 as *"missing or malformed `?doc`, a text frame,
or an unknown message type"* and **omits the Origin case**. The omission is also in the source
comment in `packages/shared/src/protocol.ts`.

### 4.4 `truncated` runs report `exitCode: null`

Verified: the 1 MB output cap produced `status=ok, exitCode=null, truncated=true`. My docs state
the status correctly but never say that `exitCode` is **null** in this case — a reader could
reasonably expect a number. Worth one clause.

### 4.5 Stale build artifact in `dist`

`apps/server/dist/modules/persistence/__scratch.js` (dated Aug 13) has **no corresponding
source file** — `__scratch.ts` was deleted without running `tsc -b --clean`, so a dead compiled
module persists in the build output and survives `tsc -b --force`. Harmless (nothing imports it)
but it ships in `dist`.

### 4.6 No discrepancies found in these areas

Checked and **consistent**: Prisma schema ↔ ER diagram (every field, key, `onDelete` and index);
API routes ↔ `API.md` (every method, path, status and error code, verified live); the execution
state machine ↔ observed statuses (`ok`/`timeout`/`error` only — no "killed" state exists, as
documented); architecture ↔ implementation (`apps/runner` has no Prisma/Express/Yjs import;
`apps/server` has no Docker import); Yjs claims ↔ behaviour; and **every documented numeric
constant** (`RUN_TIMEOUT_MS`, `MAX_OUTPUT_BYTES`, `MAX_RUN_FILES`, `MAX_RUN_INPUT_BYTES`,
`FLUSH_DELAY_MS`, `FLUSH_BYTES`, `COMPACT_AFTER`, `COMPACT_LAG_MS`, `MAX_ACTIVE_RUNS`,
`ENTRY_TTL_MS`, worker `CONCURRENCY`, `REAPER_INTERVAL_MS`, reaper `DEFAULT_MAX_AGE_MS`,
`BASE_DELAY_MS`, `MAX_DELAY_MS`, `SESSION_MAX_AGE_SECONDS`) matched source exactly.

**No invented claims, fabricated metrics or unsupported security claims were found in the Phase 3
documentation set.** Every number in it is now either re-verified or explicitly dated to a prior
measurement.

---

## 5. Security audit results

| Area | Verdict | Evidence |
|---|---|---|
| **WebSocket authentication** | **Sound.** Cookie-only; 4401 for absent or invalid tokens; no `?token=` accepted | §2.5, observed |
| **Document authorization** | **Sound.** Shared `assertProjectAccess`; a doc id is not a capability; cross-project file ids and directories both rejected; non-member indistinguishable from non-existent | §2.5, observed |
| **Execution authorization** | **Sound.** EDITOR on both routes; job ids are project-bound; cross-project stream replay refused | §2.12, observed |
| **Container isolation** | **As documented — shared kernel.** Namespaces + cgroups only | §2.11 |
| **Network access** | **Blocked.** `--network none` confirmed by a live connection attempt | §2.11, observed |
| **Host access** | **None found.** No bind mounts; root filesystem read-only; **`/var/run/docker.sock` absent inside the container** | §2.11, observed |
| **Filesystem access** | **As documented.** Read-only rootfs, writable `/work` with **no total cap**, 32 MiB per file | §2.11, observed |
| **CPU / memory limits** | **Enforced.** 1 GB allocation OOM-killed at exit 137 with the host unaffected | §2.11, observed |
| **Timeout** | **Enforced.** 9,953 ms then killed | §2.11, observed |
| **Termination & cleanup** | **Reliable.** 0 leftover containers, 0 dangling volumes after 14 runs including kills | §2.11, observed |
| **Database / Redis access from user code** | **None.** No credentials in the container environment at all, and no network to reach them | §2.11, observed |
| **Docker socket** | **Not exposed to user code.** Owned solely by `apps/runner` | §2.11, observed |

### Security gaps confirmed

1. **A missing `Origin` header passes both the REST guard and the WS upgrade** — verified live.
   `Origin` therefore defends against browsers only, never against a client holding a stolen
   cookie. `SameSite=Strict` is the primary CSRF control.
2. **No rate limiting anywhere** — I sent 24 run requests and dozens of logins with no throttling
   of any kind. Only the 20-entry registry cap pushed back, and only on runs.
3. **Sessions cannot be revoked.** Not re-tested; unchanged by code reading.
4. **Revocation does not cross instances.** Not directly re-tested this phase; the hooks
   demonstrably walk one process's rooms only.
5. **A VIEWER's rejected edits persist in their own browser** until reload — observed in §2.6.
   Their local `Y.Doc` diverges from the server's silently, with no UI signal beyond the
   read-only badge.
6. **`/work` has no total size cap** — unchanged, and re-confirmed by reading the flags.
7. **The Docker socket is root-equivalent on the host.** The mitigation is architectural, not a
   sandbox: anything achieving code execution *in the runner process* owns the host.

**No new vulnerability was discovered.** Every gap above was already documented in
[SECURITY.md](../docs/SECURITY.md); this phase converted them from code-read to observed.

---

## 6. Documentation corrections — ALL APPLIED

None of these were wrong-in-substance; they were omissions or imprecision found by running the
system. They were identified during the audit-only phase and **have since all been applied**.
The applied form is recorded in
the documentation audit §8.

| # | File(s) | Correction |
|---|---|---|
| 6.1 | `docs/API.md` §8 close-code table; `docs/REALTIME.md` §10 | **Add `Origin` mismatch as a cause of close code 4400.** Currently omitted (§4.3) |
| 6.2 | `docs/REALTIME.md` §8 and §10 | **Qualify "gap repair is Yjs's".** A dropped doc-bus frame is repaired only on a **re-sync**; while both sockets stay open it is permanently lost. Add the observed incident (§4.1) and the un-awaited `subscribe` window |
| 6.3 | `docs/EXECUTION.md` §7 / state diagram note on `Ok` | State explicitly that a **truncated** run reports `exitCode: null` (§4.4) |
| 6.4 | `docs/SECURITY.md`, `docs/REALTIME.md` | Note that a **VIEWER's rejected edits remain in their own browser** until reload (§5, gap 5) |
| 6.5 | `docs/SECURITY.md` Part 4 | Upgrade the manual-verification table: the sandbox controls, WS auth, authorization and persistence are now verified **2026-09-03**, not only 2026-08-14 |
| 6.6 | `docs/SETUP.md` troubleshooting | Add: a stale `dist` can hide a rebuild; `npx tsc -b --force` is the fix. Optionally mention the orphan `__scratch.js` (§4.5) |
| 6.7 | `CLAUDE.md` | Phase status claimed 9/10/11 were uncommitted; all three are committed (`34d5fc3`, `b8e9e25`, `590d900`). Corrected, contradictory "working tree" phrasing removed, and a Phase 12 entry added |

---

## 7. Remaining limitations

Unchanged from [SECURITY.md](../docs/SECURITY.md) Part 6, with these now **observed rather than
inferred**: single-instance run routing (404 across instances), the 20-run cap, the 100-file cap,
the absence of rate limiting, the read-only rootfs, network isolation, non-root execution, memory
and timeout enforcement, and container/volume cleanup.

**Newly characterised this phase:**

- Cross-instance propagation measured at **~41 ms** on this machine (loopback, two local
  instances, one Redis) — a new datum, not previously measured.
- The doc bus has a **small silent-loss window at subscription time** (§4.1).
- **The dev database now contains audit data I created**: 11 users matching
  `^(a|b|own|vw|wo|wv|wx|run|out|cap|bus)[0-9]+@ex\.com$`, roughly 14 projects, ~117 files. Totals
  are now 71 users / 67 projects / 265 files / 3,503 `DocUpdate` rows / 143 snapshots. **I have
  not deleted any of it** — say the word and I will remove exactly those rows, or leave it.

---

## 8. Unresolved questions

**Resolved since this audit was first written:**

- ~~Should the §6 corrections be applied?~~ **All seven applied** — see
  the documentation audit §8.
- ~~`CLAUDE.md`'s phase status~~ **Corrected**, with a Phase 12 entry added.
- ~~Where should this file live?~~ **`documentation/`**, consolidated — see the location note.

**Still open:**

1. **T1–T6 results** (§3). Until reported, offline editing, browser presence, the runner-down
   gap, revocation-in-the-UI and small-viewport behaviour remain
   **UNVERIFIED — MANUAL CHECK REQUIRED**. This is the single largest gap left in the
   documentation.
2. **Audit data in the dev database** (§7): 11 users, ~14 projects, ~117 files created by this
   audit remain in `collab_editor`. Remove them, or leave them? Removal would be the projects
   owned by those accounts first, then the accounts.
3. **Environment hygiene:** two `dev:runner` processes are running, and `:4000` serves a stale
   Aug-14 build. Intentional, or worth restarting?
4. **The doc-bus subscribe window** (§4.1) is a code-level observation, not a documentation
   problem. Whether to await the Redis `SUBSCRIBE` acknowledgement is an implementation decision
   and is deliberately **not** made here.
5. **No phase-11 or phase-12 plan or summary exists** in `docs/plans/`, breaking the pattern
   every earlier phase follows. Phase 11 is covered by `docs/notes/compaction.md`; Phase 12 is
   covered only by `CLAUDE.md` and `docs/ARCHITECTURE.md` §7.
