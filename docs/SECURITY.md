# Security & limitations

This document states what is protected, what is not, what has been tested, and where this
project actually runs.

> **This project is not production-ready and this document does not claim it is.** It executes
> arbitrary user code in a shared-kernel container, has no rate limiting anywhere, cannot revoke
> a session, has no automated tests for the sandbox, and has never been deployed. Each of those
> is documented below with the evidence for it.

**Source of truth:** the modules named in each section, read on **2026-09-03**. Statements are
labelled `[code]` (read in source), `[run]` (observed by executing it during this audit),
`[doc]` (a recorded past measurement, not re-verified) or `[unverified]`.

---

# Part 1 — Authentication and access control

## 1.1 API authentication

| | |
|---|---|
| Mechanism | HS256 JWT signed with `jose`, carried in the **`ce_session` cookie** |
| Cookie flags | `httpOnly`, `SameSite=Strict`, `path=/`, `secure` when `NODE_ENV=production`, `maxAge` 7 days |
| Claims | `sub` (user id), `email`, `iat`, `exp` |
| Verification | `jwtVerify(token, secret, { algorithms: ['HS256'] })` — the algorithm is pinned, so an `alg: none` token is rejected |
| After verification | **The user row is re-read.** A token for a deleted user fails |
| Failure response | Always `401 UNAUTHENTICATED`. "No cookie", "expired", "tampered" and "user gone" are not distinguished `[code]` |

There is **no `Authorization` header path, no bearer token, no API key and no OAuth.**

**Password storage** — `scrypt` from `node:crypto`, `N = 2^15, r = 8, p = 1`, 16-byte random
salt, 64-byte key, encoded `scrypt$N$r$p$salt$hash` so the parameters travel with the hash and
raising the cost later does not invalidate existing ones. Comparison is `timingSafeEqual`. `[code]`

**Account enumeration is equalised.** An unknown email and a wrong password return the identical
`401 INVALID_CREDENTIALS`, and the unknown-email path burns an **equal-cost dummy scrypt**
(`burnVerificationTime`), built at startup rather than on first use so the very first
unknown-email login is not measurably slower. `[code]` — asserted by a test. `[run]`

> **This is a timing *equaliser*, not a formal constant-time guarantee.**

**CSRF.** `SameSite=Strict` is the primary defence. `originCheck` is the second line: on
**mutating methods only** (`POST`/`PUT`/`PATCH`/`DELETE`), a present-and-mismatched `Origin`
gets `403 BAD_ORIGIN`. **A missing `Origin` header is allowed through** — curl and
server-to-server callers do not send one. So `Origin` defends against browsers, not against a
client holding a stolen cookie. `[code]`

**XSS reach for the token.** `httpOnly` means no page script can read the cookie.

## 1.2 WebSocket authentication

`ws://<origin>/ws?doc=<projectId>:<fileId>`.

- **The session cookie authenticates the upgrade.** The `Cookie` header is parsed by hand
  (cookie-parser is Express middleware and does not apply to an upgrade), and the same
  `authenticateToken` runs. `[code]`
- **There is no `?token=` parameter**, deliberately — a token in a URL lands in proxy logs and
  `Referer` headers. `docs/PLAN.md` row 3.2 specifies one; it was never built.
- **`Origin` is checked here explicitly**, because `originCheck` guards mutating HTTP methods
  and an upgrade is a GET. **A missing `Origin` is allowed through**, same as REST.
- **Every rejection is an application close code**, not a pre-upgrade HTTP status — a browser
  cannot read the latter (`onclose` gives 1006 with no reason).
- `WebSocketServer({ noServer: true })` is what makes refusal possible at all.

## 1.3 Document authorization

**Knowing a document id is not sufficient to join.** `[code]`

Before the socket is attached to any room, `syncHandler.ts` calls
`assertProjectAccess(userId, projectId, 'VIEWER')` — **the same function the REST layer uses**,
so the two surfaces cannot drift.

| Situation | Result |
|---|---|
| Not a member | Close **4404** — identical to "no such file". Project existence stays private |
| Member, but below the minimum | Close **4403**. Currently unreachable: VIEWER is the floor |
| Member, VIEWER | Admitted **read-only** |
| Member, EDITOR or OWNER | Admitted read-write |

Three further checks:

- The `projectId` half of the doc id is **never trusted alone**: the room query is
  `findFirst({ where: { id: fileId, projectId } })`, so a file id from another project does not
  resolve.
- The doc id is validated for **shape only** at the door; existence and membership come after.
- **A VIEWER's writes are dropped server-side.** Any Sync frame that is not sync step 1 is
  refused and logged. The disabled editor in the UI is described in the source as *"a courtesy;
  this is the control."*

**Authorization runs once, at join** — a membership check per keystroke would be a database read
per keystroke. What makes that safe is that a role change, a removal, a project delete and a
file delete all close the affected sockets with **4409**, from hooks the services call *after*
the database change commits. `[code]`

> **That revocation does not cross server instances.** See §3.2.

**No caching.** `assertProjectAccess` reads the membership row on every call, deliberately: a
stale permission is a security bug, and it is a single index lookup on
`@@unique([projectId, userId])`.

## 1.4 Execution authorization

**Both execution routes require EDITOR, not VIEWER** — running code consumes host CPU and memory
and executes whatever the project contains. `[code]`

**Can a user execute code in a project they should not access?** No, on the evidence read:

- `POST /run` is guarded by `requireProjectRole('EDITOR')`; a VIEWER gets 403, a non-member 404.
- The entrypoint must resolve inside **that project's own** file list (`listFilesForRun(projectId)`).
- **The client never names a language.** It is resolved from the file extension, because a client
  that could pair arbitrary code with an arbitrary container image would be a hole.
- The SSE stream is authorized **three ways**: authenticated; EDITOR *now* (membership may have
  changed since the POST); and `entry.projectId === :projectId`. A job id from another project
  is a 404, the same code as an unknown job. **A `jobId` is not a capability.**

## 1.5 Other server-side protections

| | |
|---|---|
| Path traversal | `assertValidPath` rejects `..`, `.`, absolute paths, backslashes, control characters and empty segments — **rejected, never rewritten**. Re-checked in the runner with a `path.resolve` prefix test before staging |
| SQL injection | Prisma parameterises. The one raw identifier (`create database "<name>"` in the test bootstrap) is derived from your own `.env` and suffix-checked |
| Command injection | Every Docker call is an **argv array**; **no `shell: true` anywhere** in `apps/runner` |
| Error leakage | One envelope; **stack traces never cross the wire**; unexpected errors log server-side and return a bare `500 INTERNAL_ERROR` |
| Password hash leakage | `passwordHash` is not a field on any serialized user shape, so it cannot leak from a future route by accident |
| Body size | `express.json({ limit: '1mb' })` |
| Enumeration by project id | 404-not-403 for non-members, everywhere, including the WebSocket |

---

# Part 2 — The sandbox

**This is a reasonable local sandbox, not production-grade isolation.**

## 2.1 Isolation

Docker containers on a **shared host kernel**. Only Docker's **default seccomp profile** applies
— no custom profile was written. There is **no user-namespace remapping, no rootless Docker and
no gVisor or Firecracker.** `[code]`

**A kernel exploit escapes this.** What it does defend against is ordinary hostile or broken
code: infinite loops, fork bombs, memory exhaustion, network access and filesystem writes.

## 2.2 The controls, and the evidence for each

| Control | Setting | Evidence |
|---|---|---|
| **Network** | `--network none` — no outbound connection of any kind | `[code]`; a socket to `1.1.1.1:53` failed with `OSError` `[doc — 2026-08-14]` |
| **CPU** | `--cpus 0.5` | `[code]` |
| **Memory** | `--memory 256m` with `--memory-swap 256m` — equal, so **no swap**: a large allocation is OOM-killed rather than paged out | `[code]`; a 1 GB allocation gave `exit=137` with the host and server process unaffected `[doc]` |
| **Processes** | `--pids-limit 64` | `[code]`; a fork bomb was blocked after ~11 forks `[doc]` |
| **Timeout** | **10 s** wall clock, then `docker kill` | `[code]`; `while True: pass` ended at **10,222 ms** with the container gone `[doc]` |
| **Output** | **1,000,000 bytes**, then killed | `[code]` |
| **Filesystem** | `--read-only` rootfs; `/tmp` a 32 MB tmpfs; `/work` a writable **anonymous volume** | `[code]`; a write to `/` was refused with `Read-only file system` `[doc]` |
| **Per-file size** | `--ulimit fsize=33554432` (32 MiB) | `[code]`; a 200 MB write stopped at exactly 32 MB with `EFBIG` `[doc]` |
| **Privileges** | `--user 1000:1000`, `--cap-drop ALL`, `--security-opt no-new-privileges`. Both images build or reuse a uid-1000 non-root user | `[code]` |
| **Registry access** | `--pull never` — a missing image fails locally rather than fetching | `[code]` |
| **Cleanup** | `--rm`, plus an explicit `docker rm -fv` in a `finally`, plus a label-and-age-filtered reaper | `[code]`; 0 `ce.run` containers and 0 dangling volumes after the test batch `[doc]` |

## 2.3 Host, database, Redis and Docker socket

- **Host filesystem access: none.** There are **no bind mounts**. Files enter via
  `docker create` → `docker cp` from a host temp directory → `docker start -a`, and that temp
  directory is removed afterwards. `[code]`
- **Database access from user code: none.** The runner imports no Prisma and holds no database
  connection; it receives plain text in the job payload and has no idea what a document is. Its
  entire dependency list is `@collab/shared`, `bullmq`, `ioredis`. `[code]`
- **Redis access from user code: none.** The container has `--network none`, so it cannot reach
  Redis, Postgres, the server, or anything else. `[code]`
- **Docker socket exposure.** Access to the Docker socket is **effectively root on the host**.
  It is owned solely by `apps/runner`, **a process that serves no HTTP or WebSocket traffic**,
  and `apps/server` imports no Docker anything. **This is an architectural mitigation, not a
  sandbox**: anything that achieves code execution *in the runner process* — as opposed to
  inside a container — owns the host. `[code]`

## 2.4 What the sandbox does not bound

- **`/work` has no total size cap.** `--ulimit fsize` bounds any single file to 32 MiB; a program
  can write many files. What bounds the total is the 10-second timeout — growth is bounded in
  practice by disk throughput × 10 s, not by a quota. **Never describe `/work` as
  size-limited.** A hard cap needs an XFS project quota or a loopback filesystem.
- **No per-user or per-project run quota.** Worker concurrency 2 and the 20-entry registry cap
  are the only backpressure in the system.
- **No egress logging, no syscall auditing, no runtime monitoring.**

---

# Part 3 — Missing protections

## 3.1 No rate limiting, anywhere

There is **no rate limiting on any route** — not on `POST /api/auth/login`, not on registration,
not on project or file mutations — and **no rate limit, message-size cap or connection cap on
`/ws`**. `[code]`

This matters more since the client gained automatic reconnection: browsers now retry on their
own. The only things stopping a storm at the source are the terminal close codes and the capped
jittered backoff — both **client-side**, and therefore not a control.

## 3.2 Sessions and revocation

- **A session cannot be revoked before it expires.** One 7-day access token, no refresh, no
  rotation, no denylist, no server-side session record. `POST /logout` clears the cookie; **a
  stolen token remains valid for the rest of its 7 days.** Adding refresh touches only
  `modules/auth/token.ts`.
- **Revocation does not cross server instances.** The 4409 hooks walk *this process's* rooms, so
  a user whose role changed or who was removed keeps a live socket on the other instance until
  they disconnect. They cannot re-enter or reach anything new — authorization runs at every join
  and every REST call — but an open editor stays open. The fix is a revocation channel on the
  existing bus.
- **Membership changes take effect on the next REST request.** Over WebSockets they are
  immediate (within one instance).

## 3.3 Data that outlives permission

**Local IndexedDB is never cleared, and revocation does not reach it.** A VIEWER who opens a file
keeps a copy in the browser; if an OWNER later removes them, the socket closes with 4409 but
**the local copy stays on disk and stays readable offline indefinitely**. Two accounts on one
browser profile share those databases, because the database name is the `docId` and is not
user-scoped. Fixing it means user-scoping the name or a logout hook into every provider. `[code]`

**A VIEWER's rejected edits stay in their own browser.** The server drops a VIEWER's writes and
never applies them, but the VIEWER's local `Y.Doc` has already applied them optimistically.
Observed on 2026-09-03: the VIEWER's own session read `"VIEWER-TEXT;OWNER-TEXT;"` while the
server — and every other client — held `"OWNER-TEXT;"`. The divergence is silent, with no signal
beyond the read-only badge, and it disappears on reload. Nothing is written to the server, so
this is a **UI honesty problem, not an authorization hole**. `[run]`

## 3.4 Cookie scope

**`SameSite=Strict` does not isolate by port.** `localhost:4000` and `localhost:5173` are the
same site, so the session cookie reaches a socket opened directly at `:4000`. **The `Origin`
check in the handshake is what carries that weight, not the cookie flag.** `[code]`

## 3.5 Everything else absent

No password reset. No email verification. No account lockout. No MFA. No audit log. No soft
delete. No pagination (so `GET /api/projects` and the file tree return everything). No CSP,
HSTS, or other security headers beyond disabling `x-powered-by`. No dependency scanning, no
linter, and no CI to run either.

---

# Part 4 — Testing status

## 4.1 What exists

`npm test` → **245 tests in 13 files, all passing, 46.80 s**, against a real
`collab_editor_test` PostgreSQL database. Re-run and observed on **2026-09-03**. `[run]`

| File | Tests | Covers |
|---|---|---|
| `paths.test.ts` | 37 | Path validation and normalisation (pure) |
| `files.test.ts` | 29 | File CRUD, move/rename, recursive delete, role gating |
| `rooms.test.ts` | 26 | Room registry, load/flush, the log-growth regression |
| `collab.test.ts` | 25 | WS handshake, sync, awareness, authorization, revocation |
| `projects.test.ts` | 24 | Projects CRUD, membership, 404-vs-403 |
| `protocol.test.ts` | 22 | `parseDocId`, close codes, framing (pure) |
| `docStore.test.ts` | 21 | Log, snapshots, `readForCompaction`, the CAS |
| `auth.test.ts` | 17 | Register/login/logout/me, timing equalisation |
| `authorize.test.ts` | 14 | `assertProjectAccess`, role ranking |
| `execution.test.ts` | 12 | Run request validation, caps, SSE route authorization |
| `docBus.test.ts` | 9 | Frame encode/decode, echo suppression, subscribe/unsubscribe |
| `foundation.test.ts` | 6 | App wiring, health, the error envelope |
| `compaction.test.ts` | 3 | Cross-instance compaction, the racing-compactor CAS |

No mocks for the database — every one of these runs against real Postgres.

## 4.2 What is not tested

- **`apps/runner` has no tests and no test script.** The Docker driver, the limits layer and the
  reaper have **zero automated coverage**. The part of this system that executes untrusted code
  is the part with no tests.
- **`apps/web` has no tests and no test script.** Zero frontend tests. A deliberate, recorded
  scope decision — the client is verified by browser click-through only. **The entire offline
  and reconnection feature is client-side and therefore entirely click-through-verified.**
- **`loadtest` has no tests.**
- **No linter** in any workspace.
- **No CI**, so nothing runs the suite automatically.
- **`execution.test.ts › "allows an EDITOR"` hangs and fails when Redis is down** — it reaches
  BullMQ's lazy `queue.add`, measured still pending after 5,004 ms. Pre-existing; the test's
  comment claiming it works either way is what is wrong. The rest of the suite is genuinely
  Redis-free. `[doc]`

**All 245 tests are `apps/server` tests.** Quoting "245 tests" as coverage of *the system* would
be misleading.

## 4.3 Manual and runtime verification on record

### Verified by executing the system on 2026-09-03 (`[run]`)

A clean forced rebuild was run on isolated ports (`:4002`, `:4003`) and driven headlessly — REST
via `fetch`, collaboration via a real `ws` + `yjs` client, run output via SSE. Protocol constants
were hardcoded rather than imported from `@collab/shared`, so the tests checked *against* the
contract rather than restating it. Full evidence:
[`documentation/03-final-audit.md`](../documentation/03-final-audit.md).

| Area | Result |
|---|---|
| REST surface | Every documented status and error code reproduced |
| 404-vs-403 privacy | Non-member and non-existent project return **byte-identical** 404s on project, files and run routes |
| Login timing equaliser | **Measured**: wrong-password median 95.5 ms vs unknown-email 91.5 ms (10 samples each) |
| WebSocket authentication | 4401 for absent and invalid cookies; sync only with a valid one |
| WebSocket authorization | 4404 for non-member, unknown file, **cross-project file id**, and a **directory** id |
| `Origin` on the upgrade | Mismatch → **4400**; **missing header → admitted** |
| VIEWER read-only | Write dropped server-side, server text unchanged, log line emitted |
| Live revocation | Socket closed **4409**; rejoin then refused **4404** |
| Persistence | Type over WS → 2 s flush → `File.content` matched exactly; cold reopen showed no duplication |
| Cross-instance doc bus | Propagated **~41 ms** both ways and converged (3 of 4 trials — see §4.1 of the final audit) |
| Sandbox: privileges | `uid 1000 gid 1000` |
| Sandbox: network | Connection to `1.1.1.1:53` refused |
| Sandbox: filesystem | `/` read-only (`Errno 30`); `/work` writable |
| Sandbox: credentials | **No `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` or `POSTGRES_*` in the container environment** |
| Sandbox: Docker socket | `/var/run/docker.sock` absent inside the container |
| Sandbox: memory | 1 GB allocation → exit 137, host unaffected |
| Sandbox: timeout | Killed at 9,953 ms |
| Sandbox: output cap | Cut at **exactly 1,000,000 bytes**, reported `ok` + `truncated`, `exitCode: null` |
| Sandbox: cleanup | **0** leftover `ce.run` containers and **0** dangling volumes after ~14 runs |
| Execution caps | Exactly 20 × `202` then `429`; 101 files → `413` |
| Cross-instance runs | Stream from the other instance → **404**; from the accepting instance → **200** |

### Earlier manual verification

| What | When | Notes |
|---|---|---|
| Six sandbox safety tests (timeout, fork bomb, OOM, network, root write, cleanup) | 2026-08-14 | Run through the real driver from a throwaway script, since deleted. `docs/notes/sandbox-tests.md`. **Re-confirmed 2026-09-03** by the table above |
| Two-instance convergence and presence in two browser profiles | Phase 7 | `docs/notes/scaling.md`. One caveat recorded there: the instance-restart step is **operator-reported**, not observed by the session that stopped the instance |
| Compaction under a 300 s two-instance load run | Phase 11 | `docs/notes/compaction.md` |
| Below-`md` responsive layout | Phase 10 | **User-verified by hand**, because the automated browser could not resize its viewport |
| Hard-kill durability (`pkill -9`, restart, reload, text intact) | Phase 4 | `docs/plans/summary4.md` |

## 4.4 Still unverified — manual check required

Containers **were** started and the collaboration protocol **was** driven headlessly (§4.3). What
remains unverified is everything that needs a **real browser**, because no browser was driven at
any point in this project's documentation work:

| Item | Status |
|---|---|
| Offline editing and the reconnect status line | **UNVERIFIED — MANUAL CHECK REQUIRED** |
| Remote cursors and the presence facepile rendering | **UNVERIFIED — MANUAL CHECK REQUIRED** |
| Two-instance convergence *as seen in two browsers* | **UNVERIFIED — MANUAL CHECK REQUIRED** (the protocol-level equivalent is verified — §4.3) |
| The Run button and terminal UI end to end | **UNVERIFIED — MANUAL CHECK REQUIRED** (the API and sandbox beneath it are verified — §4.3) |
| Behaviour when the runner is stopped | **UNVERIFIED — MANUAL CHECK REQUIRED** (predicted from code: the stream is never closed) |
| Revocation as experienced in the UI | **UNVERIFIED — MANUAL CHECK REQUIRED** (the 4409 close is verified — §4.3) |
| The search palette and small-viewport layout | **UNVERIFIED — MANUAL CHECK REQUIRED** |

Step-by-step procedures: [`documentation/03-final-audit.md`](../documentation/03-final-audit.md)
§3 (tests **T1–T6**), plus the shorter lists at the end of [REALTIME.md](REALTIME.md) and
[EXECUTION.md](EXECUTION.md).

**Nothing above may be described as verified until those results are reported.**

---

# Part 5 — Deployment status

| Question | Answer |
|---|---|
| **Is it actually deployed anywhere?** | **No.** Nothing in the repository indicates it has ever run outside a developer machine |
| **Does deployment configuration exist?** | **No.** See below |
| **Has deployment configuration been tested?** | **Not applicable** |
| **Is it locally runnable?** | **Yes** — verified 2026-09-03: both containers healthy, 245 tests passing, `build:web` succeeding `[run]` |

**What was searched for and does not exist** `[code]`:

- No `Dockerfile` for `apps/server`, `apps/web` or `apps/runner`. **The only Dockerfiles in the
  repository are the two sandbox images for user code** (`infra/images/`), which are not
  application deployment artifacts.
- No `.github/` directory — **no CI, no build pipeline, no automated test run, no dependency
  scanning**.
- No `render.yaml`, `fly.toml`, `Procfile`, `app.yaml`, Kubernetes manifest, Helm chart or
  Terraform.
- The only compose file is `infra/docker-compose.yml`, which starts **PostgreSQL and Redis
  only**. It is local development infrastructure, not an application deployment.

> **The presence of Docker and Compose in this repository does not mean the application is
> containerised or deployable.** They exist to run a database, a cache, and the code sandbox.

**Deployment-*ready* properties that do exist**, and are worth distinguishing from a deployment:
`start` scripts (`node dist/index.js`) for the server and runner; a Vite production build for
the client; boot-time environment validation that refuses to start on a bad config;
`NODE_ENV=production` switching the session cookie to `secure`; and graceful SIGINT/SIGTERM
shutdown in both long-running processes, with the server flushing open documents and the runner
waiting for active jobs.

**What would be needed before deploying this**, at minimum: rate limiting, session revocation,
TLS termination and `secure` cookies end to end, sticky routing or a shared run registry, a
cross-instance revocation channel, secrets management for `JWT_SECRET`, CI running the test
suite, automated tests for the runner, and a considered decision about whether a shared-kernel
container is acceptable isolation for the code being run. That list is not exhaustive.

---

# Part 6 — Consolidated limitations

**Isolation**
- Shared kernel, default seccomp only, no user namespaces, no gVisor. A kernel exploit escapes.
- `/work` has no total size cap.
- The Docker socket is root-equivalent; the mitigation is architectural, not a sandbox.

**Authentication and authorization**
- Sessions cannot be revoked before their 7-day expiry; no refresh, no rotation.
- Revocation does not cross server instances.
- A missing `Origin` header passes both the REST check and the WS upgrade.
- `SameSite=Strict` does not isolate by port.
- Local IndexedDB copies survive revocation and are shared across accounts on one browser profile.

**Availability**
- No rate limiting, message-size cap or connection cap anywhere.
- Backpressure on execution is worker concurrency 2 plus a 20-entry cap. Nothing else.
- No pagination on any list endpoint.

**Correctness and durability**
- A hard kill loses up to ~2 s of typing (the flush debounce) — a deliberate trade.
- Orphan document rows are possible when a file is deleted while open; they are unreachable and
  never cleaned up.
- A never-opened document could be seeded twice if two instances cold-open it simultaneously.
- `pendingWrites` is per-process, so an F5 landing on the other instance does not wait on an
  in-flight append there.
- No background compaction sweep; 200 rows is a constant, not configuration.
- `INSTANCE_ID` is per process, so two instances on one Redis exchange frames even across
  different databases.

**Execution**
- Runs do not cross instances — a browser must reach the instance that took its POST (a 404
  otherwise, verified in module 7.2).
- If the runner is down, the browser waits forever rather than being told.
- No run history, cancellation, stdin, or reattachment after reload.
- An abandoned stream holds its registry slot for 120 s.
- A run does not include edits made while a client's socket was down.

**Measurement**
- Capacity is unmeasured and unmeasurable on the development machine — the load generator
  saturates four cores before the server does (402–403% of a 400% budget at 100–200 clients,
  while server CPU never exceeded 32% of one core). Published numbers describe propagation
  latency, not supported users.
- Convergence is unconfirmable above ~100 clients with the current harness (its settle window is
  shorter than p99 propagation). No errors and no dropped clients were seen in those runs.
- Flush latency and log length are not instrumented at all; compaction has been observed once
  under load but never profiled.

**Client**
- No frontend tests, no linter.
- Initial JS 315.56 kB (98.49 kB gzipped); the lazy `ProjectPage` chunk is 923.14 kB and Vite
  still warns about it. Measured 2026-09-03 `[run]`.
- Project search is client-side and bounded — at most 300 files and 120 matches, reading
  `File.content`, so results can lag the editor by a flush and never include edits made while
  the socket was down. A large project is searched **partially** and the palette says so.
- The client's 4403 handling is verified only against a fake socket.
- Deferred defects: renaming a folder leaves descendants' open tabs showing the old path; stale
  expanded-folder paths accumulate; scroll is not preserved across tab switches. None risks data.
- The application error fallback has never been rendered in anger.
