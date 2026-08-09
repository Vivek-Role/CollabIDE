# Collaborative Code Editor — Session Summary & Build Plan

> Generated 2026-08-09. Move this into the repo as `docs/PLAN.md` during module 0.2.

---

# PART 1 — SESSION SUMMARY

## What this project is

A real-time collaborative code editor — a simplified combination of **VS Code + Google Docs + an online code runner**. Multiple authenticated users edit code in a shared project simultaneously with live cursors; edits survive refresh, offline, and reconnection; a **Run** button executes their code inside a resource-limited, network-isolated Docker container with output streamed to a browser terminal.

Built solo, learning basics alongside. **Building project, not a tutorial.**

## Environment audit (verified on this machine)

| Item | Result |
|---|---|
| Windows | 11 Home Single Language, build 26200 |
| CPU | 13th Gen Intel i7-13620H |
| RAM | 15.7 GB |
| Disk C: | 207.5 GB free of 474.7 GB |
| Virtualization | ✅ **Enabled** (hypervisor detected, VBS running) — no BIOS changes needed |
| Node.js | ✅ v20.17.0 |
| npm | ✅ 11.16.0 |
| git | ✅ 2.50.0 |
| VS Code | ✅ 1.132.0 |
| Python | ✅ 3.12.0 *(not needed locally — Python runs inside the container)* |
| **WSL2** | ✅ **Ubuntu 26.04 LTS, VERSION 2** (installed 2026-08-09) |
| **Docker** | ✅ **Desktop 4.85.0, engine 29.6.2, Compose v5.3.1** (installed 2026-08-09) |
| Node (inside WSL) | ✅ v24.19.0 LTS via nvm + npm 11.17.0 |
| git (inside WSL) | ✅ 2.53.0 — **identity not yet configured** |

## Decisions made in this session

| Question | Decision | Reasoning |
|---|---|---|
| When to install Docker | **Day 0**, with Postgres + Redis in Compose | Docker is a hard requirement for the sandbox anyway; installing it first surfaces environment failures on day 0 instead of at Phase 6 |
| Project location | ~~`C:\dev\collab-editor`~~ → **`~/dev/collab-editor` inside WSL2** *(revised 2026-08-09)* | Not OneDrive (sync locks `node_modules`). Revised to live on ext4 inside Ubuntu rather than NTFS: native filesystem speed for `node_modules`/Vite HMR, native Docker socket, LF endings by default, and it matches a future Linux VPS. All npm/node/git/docker commands run **inside WSL**, not PowerShell. |
| Language | **TypeScript** everywhere | Shared types for WS protocol and job payloads catch a whole class of bugs in a real-time system |
| Sandbox languages v1 | **Python + JavaScript** | Both interpreted — no compile step, simplest runner interface, two small images |
| UI styling | **Tailwind CSS** | Fastest path to a dark IDE layout |
| Git | **Claude runs it** | Branch per phase, one commit per module, stop before merging to `main` |
| Pace | ~3 hrs/day, split into chunks | Modules sized to one 60–90 min sitting |

## Things to install (only 2 missing)

### 1. WSL2 — needs Administrator + reboot

`Win + X` → **"Terminal (Admin)"** → **Yes** on UAC → then:

```powershell
wsl --install
```

Reboot. Ubuntu then asks for a UNIX username + password (password is invisible while typing — normal).

**Fallback if that errors**, in the same admin window:

```powershell
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
wsl --set-default-version 2
```
Reboot, then `wsl --update` and `wsl --install -d Ubuntu`.

**Verify:** `wsl -l -v` → shows Ubuntu, VERSION 2

### 2. Docker Desktop for Windows

Download from **https://www.docker.com/products/docker-desktop/** (Windows – AMD64). Keep **"Use WSL 2 instead of Hyper-V"** checked.

**Verify:** `docker run --rm hello-world`

### NOT needed
❌ PostgreSQL · ❌ Redis · ❌ pnpm/yarn · ❌ sandbox language runtimes — all come from containers.

### Optional
```powershell
code --install-extension Prisma.prisma
code --install-extension bradlc.vscode-tailwindcss
code --install-extension dbaeumer.vscode-eslint
code --install-extension esbenp.prettier-vscode
code --install-extension ms-azuretools.vscode-docker
```

Cap WSL2 memory — create `C:\Users\vivek\.wslconfig`:
```ini
[wsl2]
memory=6GB
processors=4
```

## Where we are right now

**Module 0.1 — ✅ COMPLETE (2026-08-09).** WSL2 (Ubuntu 26.04 LTS) and Docker Desktop 4.85.0 are both installed and verified. `docker run --rm hello-world` passes **from inside WSL**, which is where the project runs. Node 24.19.0 LTS installed in Ubuntu via nvm. `C:\Users\vivek\.wslconfig` caps WSL2 at 6 GB / 4 processors (applies after the next `wsl --shutdown`).

Notes for future sittings:
- Elevation: `wsl --install` and the Docker Desktop installer both need Administrator; the Claude Code shell is never elevated, so those go through `Start-Process -Verb RunAs` (one UAC click).
- Docker Desktop's WSL integration was off by default — enabled via `EnableIntegrationWithDefaultWslDistro` + `IntegratedWslDistros: ["Ubuntu"]` in `%APPDATA%\Docker\settings-store.json`, then a Docker Desktop restart.
- `bash -lc` does **not** load nvm (Ubuntu's `.bashrc` returns early for non-interactive shells). Non-interactive WSL calls must `source ~/.nvm/nvm.sh` first. Interactive terminals are fine.
- wsl.exe output through PowerShell truncates past the first line; redirect to a file and read that instead.

**Blocked on before 0.2:** git identity is unset inside WSL (`user.name` / `user.email`) — needed for the first commit.

**Next action:** set git identity → module 0.2 (monorepo skeleton at `~/dev/collab-editor`, moving this file to `docs/PLAN.md`).

---

# PART 2 — BUILD PLAN

## Pacing (honest)

~3 hrs/day, split across the day. Modules are sized to fit **one ~60–90 min sitting**, so a broken-up day still ends on a clean boundary. At that rate: **Phases 0–6 (the full core through the Docker sandbox) ≈ 14–16 working days**; Phases 7–8 add ~4–5 more. The original 10–12 day figure assumed full-time days. To hit 12 days, **cut Phase 7** (its seam already exists in module 3.3).

## HOW WE WORK — module by module

**28 numbered modules** across 10 phases. Each module is one turn, and the loop is fixed:

1. Inspect existing code → 2. implement **only that module** → 3. run it → 4. fix errors → 5. **say exactly what changed** → 6. give the commands to test it → 7. **commit to git** → 8. **stop and wait.**

Rules:
- **One module per turn.** Never start the next until you say go.
- Every module has a **Done when** line. If it doesn't pass, fix before moving on.
- Modules are independently reviewable: each touches its own folder, exposes a named interface, never reaches into another module's internals.
- **Git handled for you**: branch at phase start, one conventional commit per module, stop before merging to `main`.
- If a module turns out bigger than expected, **split it** — never half-finish and move on.

**Explanation level:**
- **Node / REST / async / middleware** — no explanation, just build.
- **React + CodeMirror, Prisma/SQL schema design, Docker flags** — a short 5–10 line "what it is / why here" note the first time each appears, then straight to code. No tutorials.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React + Vite + TS, **Tailwind CSS**, CodeMirror 6, `yjs`, `y-codemirror.next`, `y-indexeddb`, `xterm.js` |
| Backend | Node 20 + TS, Express (REST), `ws` + `y-protocols` (custom WS server), JWT |
| Queue | BullMQ (Redis) + separate `runner` worker process |
| DB | PostgreSQL + Prisma |
| Cache/bus | Redis (pub/sub for collab fanout + run output) |
| Sandbox | Docker CLI driven from the runner worker |

## Repo layout (npm workspaces) at `C:\dev\collab-editor`

```
apps/
  web/                    React client
    src/features/         auth/ projects/ files/ editor/ collab/ terminal/
  server/                 REST + WebSocket + collab hub  (NEVER touches Docker)
    src/modules/          auth/ projects/ files/ collab/ persistence/ execution/ redis/
  runner/                 BullMQ worker -> Docker sandbox (NEVER touches HTTP/WS)
    src/                  worker.ts  sandbox/  languages/
packages/
  shared/                 TS types: WS protocol, job payloads, language configs
infra/
  docker-compose.yml      postgres, redis
  images/                 sandbox Dockerfiles (python, node)
loadtest/
docs/                     ARCHITECTURE.md, adr/, notes/
```

**Module boundary rules that keep it expandable:**
- `apps/server` never imports from `apps/runner` and vice versa — they communicate only through the queue + Redis channels, with payload types from `packages/shared`.
- Persistence sits behind a `DocStore` interface — swapping Postgres touches one folder.
- Adding a language is a config entry in `packages/shared/languages.ts`, no code changes.
- Every server module exports through an `index.ts` barrel; cross-module calls go through the barrel only.
- No file over ~300 lines.

---

## MODULE MAP

Legend: **Exposes** = the interface other modules are allowed to use.

### Phase 0 — Environment & skeleton · `chore/scaffold` · ~2 sessions

| # | Module | Files | Done when |
|---|---|---|---|
| **0.1** | WSL2 + Docker Desktop | — (your machine; reboot required) | `docker run --rm hello-world` succeeds |
| **0.2** | Monorepo skeleton | root `package.json` workspaces, tsconfig base, `.gitignore`, `.gitattributes` (LF), `git init` | `npm install` clean; `npm run build` no-ops without error |
| **0.3** | Infra compose | `infra/docker-compose.yml` (postgres:16, redis:7, named volumes), `.env.example` | `docker compose up -d` → both healthy |
| **0.4** | Prisma bootstrap | `apps/server/prisma/schema.prisma`, db connect, first empty migration | `npx prisma studio` opens |

### Phase 1 — Auth, projects, files · `feat/auth-projects-files` · ~5 sessions

| # | Module | Files | Exposes | Done when |
|---|---|---|---|---|
| **1.1** | Data model | `prisma/schema.prisma`: `User`, `Project`, `ProjectMember(role)`, `File(projectId,path,content,isDir)`, `DocUpdate`, `DocSnapshot` | Prisma client | `migrate dev` applies; tables visible |
| **1.2** | Auth module | `modules/auth/` — scrypt hashing (`node:crypto`, no native build on Windows), JWT sign/verify, `requireAuth` middleware | `requireAuth`, `signToken`, `verifyToken` | register → login → `/auth/me` returns the user |
| **1.3** | Authorization module | `modules/auth/authorize.ts` — `assertProjectAccess(userId, projectId, minRole)` | `assertProjectAccess` | second user gets **403** on another's project |
| **1.4** | Projects API | `modules/projects/` — CRUD + member add | REST `/projects` | create/list/delete work, all access-checked |
| **1.5** | Files API | `modules/files/` — tree list, create, rename, delete, read, write | REST `/projects/:id/files` | nested tree returns correctly; path collisions rejected |

> 1.3 is deliberately its own module: **the same function is reused by REST and by the WebSocket layer in 3.4.** Backend-enforced, never trusted from the client.

### Phase 2 — Editor shell · `feat/editor-ui` · ~4 sessions

| # | Module | Files | Done when |
|---|---|---|---|
| **2.1** | App shell + auth UI | Vite + Tailwind setup, dark IDE layout shell, `web/src/features/auth/`, router, API client with token | login/register works, protected routes redirect |
| **2.2** | Project list | `web/src/features/projects/` | create/open/delete a project from UI |
| **2.3** | File tree | `web/src/features/files/` | create/rename/delete files & folders, tree renders nested |
| **2.4** | CodeMirror pane | `web/src/features/editor/` — CM6 setup, tabs, language by extension (`@codemirror/lang-python`, `-javascript`) | edit + save-on-blur via REST; refresh keeps content |

> 2.4's REST save is **temporary scaffolding** — replaced by Yjs in 3.5. It exists so the UI is testable before collab lands.

### Phase 3 — Real-time collaboration (the core) · `feat/yjs-collab` · ~5 sessions

| # | Module | Files | Exposes | Done when |
|---|---|---|---|---|
| **3.1** | Shared protocol types | `packages/shared/protocol.ts` — message kinds, doc id format `${projectId}:${fileId}` | types | both apps compile against it |
| **3.2** | WS server + handshake | `modules/collab/wsServer.ts` — HTTP upgrade, JWT from query param | `attachWsServer(httpServer)` | unauthenticated upgrade is rejected |
| **3.3** | Room registry | `modules/collab/room.ts` — `Room{docId, ydoc, awareness, conns}`, `Map<docId,Room>`, refcount + idle eviction | `getRoom`, `releaseRoom` | rooms created on join, evicted after last leave |
| **3.4** | Sync + awareness handlers | `modules/collab/syncHandler.ts` — `y-protocols/sync` + `/awareness` relay; calls `assertProjectAccess` **before** attach | — | non-member's join is refused |
| **3.5** | Client collab provider | `web/src/features/collab/CollabProvider.ts` + `y-codemirror.next` binding, awareness `{name,color}` | `useCollabDoc(fileId)` | **two browsers, two accounts, same file → live edits + remote cursors; concurrent typing at the same offset does not corrupt text** |

*What Yjs does: CRDT merge, state vectors, incremental updates, tombstones. What we build: transport, auth, room registry, persistence, cross-instance fanout.*

### Phase 4 — Persistence · `feat/persistence` · ~4 sessions

| # | Module | Files | Exposes | Done when |
|---|---|---|---|---|
| **4.1** | `DocStore` interface | `modules/persistence/DocStore.ts` | `load(docId)`, `appendUpdates`, `writeSnapshot` | compiles; Postgres impl injectable |
| **4.2** | Postgres store | `modules/persistence/postgresDocStore.ts` | implements 4.1 | round-trips a Y.Doc through the DB |
| **4.3** | Write buffer | `modules/persistence/buffer.ts` — `ydoc.on('update')` → flush on 2s debounce **or** 64KB, whichever first; flush on last-disconnect and `SIGINT` | `attachPersistence(room)` | typing ≠ one DB write per keystroke (verify row counts) |
| **4.4** | Snapshot + compaction | `modules/persistence/compactor.ts` — >200 updates → `Y.encodeStateAsUpdate` snapshot + delete superseded rows in one transaction; materialize plain text into `File.content` | — | `doc_updates` count **drops** after compaction; **kill server hard → restart → content intact** |

> 4.4 materializing `File.content` is what lets the runner and file listings read plain text without ever loading Yjs.

### Phase 5 — Offline & reconnection · `feat/offline-reconnect` · ~3 sessions

| # | Module | Files | Done when |
|---|---|---|---|
| **5.1** | Local persistence | `y-indexeddb` per doc in the provider | offline hard-refresh still shows local edits |
| **5.2** | Reconnect logic | exponential backoff + jitter in `CollabProvider`; resync is Yjs's job (state-vector exchange) | offline → type → online → both peers converge |
| **5.3** | Status UI | `Connected / Reconnecting / Offline / Synced` chip driven by provider events | states change correctly when toggling DevTools offline |

### Phase 6 — Code execution sandbox (largest) · `feat/code-execution` · ~8 sessions

| # | Module | Files | Exposes | Done when |
|---|---|---|---|---|
| **6.1** | Language registry | `packages/shared/languages.ts` — `{id, image, filename, cmd[], compile?}` | `LANGUAGES` | adding a language = one config entry, zero code |
| **6.2** | Sandbox images | `infra/images/python.Dockerfile`, `node.Dockerfile` — non-root `runner` user | — | both images build; `docker run` prints a version |
| **6.3** | Docker driver | `runner/src/sandbox/docker.ts` — single `runInContainer(spec)`: `docker create --rm --network none --memory 256m --memory-swap 256m --cpus 0.5 --pids-limit 64 --read-only --tmpfs /tmp:rw,size=32m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 -w /work --label ce.run=<id>` → `docker cp` → `docker start -a` | `runInContainer` | hello-world runs in both languages |
| **6.4** | Limits & cleanup | timeout (10s wall clock) → `docker kill` + `TIMEOUT`; output cap ~1MB → truncate + kill; **reaper** sweeping `--filter label=ce.run` older than 60s on boot + interval | — | see safety test table below |
| **6.5** | Queue + worker | `runner/src/worker.ts` — BullMQ `Worker` (concurrency 2) on `exec` queue; publishes output frames to Redis `run:<jobId>` | — | job flows queue → container → Redis |
| **6.6** | Backend execution module | `modules/execution/` — `POST /projects/:id/run` → authorize → materialize files → enqueue → return `jobId`; subscribe `run:<jobId>` → forward over the user's existing WS | REST + WS frames | jobId returned, frames arrive client-side |
| **6.7** | Terminal UI | `web/src/features/terminal/` — xterm.js (display-only), Run button, exit code + duration line | — | click Run → streamed output appears |

**6.4 safety tests — all must pass, results recorded in `docs/notes/sandbox-tests.md`:**

| Test | Expected |
|---|---|
| `while True: pass` | TIMEOUT, container gone |
| fork bomb | blocked by `--pids-limit` |
| allocate 1 GB | OOM-killed, **server unaffected** |
| `socket` / `fetch` to internet | fails (`--network none`) |
| write to `/` | read-only filesystem error |
| after all of the above | `docker ps -a` clean |

> **This is a reasonable local sandbox, not production-grade isolation.** Documented residual risks: shared kernel, no seccomp/user-namespace hardening, no gVisor. Do not claim otherwise anywhere in the docs.

### Phase 7 — Horizontal scaling · `feat/redis-scaling` · ~3 sessions *(first to cut if time runs short)*

| # | Module | Files | Done when |
|---|---|---|---|
| **7.1** | Redis fanout | `modules/redis/docBus.ts` — channel per doc, publish with `instanceId`, ignore own echoes; lazy subscribe on first local join, unsubscribe on last leave | user A on `:4000` and user B on `:4001` edit the same file and converge |
| **7.2** | Multi-instance run | port config, run 2 instances, tiny proxy or two tabs on different ports | no duplicate/echoed updates; awareness works across instances |

### Phase 8 — Load testing · `test/load-testing` · ~3 sessions

| # | Module | Files | Done when |
|---|---|---|---|
| **8.1** | Client harness | `loadtest/client.ts` — headless Yjs clients over `worker_threads`, configurable clients / edits-per-sec / doc spread | N clients connect and edit |
| **8.2** | Metrics | latency = local-edit → remote-apply via embedded marker; p50/p95/p99 from real samples; server CPU/RSS, Redis ops/sec, DB write rate | percentiles printed |
| **8.3** | Two scenarios + writeup | **distributed** (N clients over M docs) and **hot doc** (all clients, one file) → `docs/notes/loadtest-results.md` with exact command, hardware, date | results table exists |

> **Only measured numbers go in docs or résumé bullets.** No estimates, no invented benchmarks.

### Phase 9 — Docs & polish · `docs/architecture` · ~2 sessions

| # | Module | Done when |
|---|---|---|
| **9.1** | `docs/ARCHITECTURE.md` + the 5 ADRs + "what Yjs does vs what I built" + known limitations | readable end to end |
| **9.2** | README quickstart, seed/demo script, error & empty states | fresh clone → running in under 10 minutes |

---

## KEY ARCHITECTURE DECISIONS (ADRs in `docs/adr/`)

These exist so you can answer: *What did I choose? Why? What did I reject? What are the trade-offs?*

**ADR-001 — Yjs transport: hand-rolled `y-protocols` WS server.**
Not `y-websocket`'s bundled server (black box: no hook for auth, per-doc authorization, our persistence, or Redis fanout). Not Hocuspocus (good product, but its extension model hides exactly the sync/awareness mechanics worth understanding). ~250 lines gives control at every seam. **Trade-off:** we own reconnect edge cases and message framing.

**ADR-002 — Persistence: append-only op log + periodic snapshot + compaction.**
Not full-document write per change (write amplification). Not snapshot-only (loses updates between snapshots on crash). Load = latest snapshot + tail updates.

**ADR-003 — Multi-instance transport: Redis Pub/Sub, not Streams, not Kafka.**
Collab fanout is ephemeral, at-most-once-tolerable traffic: durability already lives in Postgres, and Yjs self-heals any gap on the next sync round-trip — so Streams' consumer groups and retention buy nothing here while adding XADD/XREAD cost and trim management. Streams *are* right where at-least-once matters, so reserve them for run-output replay if we later want a client to reattach mid-execution. Kafka: operational weight far beyond a single-machine project.

**ADR-004 — Execution: BullMQ queue + separate worker process.**
Not in-process (violates the hard rule that user code never runs in the backend, and one runaway job stalls the event loop). Not an external service (Judge0 etc. excluded). The `runner` process is the sole owner of the Docker socket.

**ADR-005 — Files into the container: `docker create` + `docker cp` + `docker start -a`, not bind mounts.**
On Windows/WSL2, bind-mounting a Windows path into a Linux container brings `--user` permission mismatches and is slow. Create → copy → start is cross-platform, keeps the rootfs read-only, and works identically on a future Linux VPS.

---

## GIT WORKFLOW

`main` stays stable and working. Branch created at each phase start, **one conventional commit per module** (`feat:`, `fix:`, `test:`, `docs:`, `chore:`) as the last step of that module's turn, and **stop before merging to `main`** — merges happen only after the phase's verify passes. Nothing is left uncommitted between modules, so you can walk away mid-day and pick up cleanly.

Branches:
```
main
 ├── chore/scaffold
 ├── feat/auth-projects-files
 ├── feat/editor-ui
 ├── feat/yjs-collab
 ├── feat/persistence
 ├── feat/offline-reconnect
 ├── feat/code-execution
 ├── feat/redis-scaling
 ├── test/load-testing
 └── docs/architecture
```

---

## LEARNING NOTES (lightweight, no tutorials)

~15 lines appended to `docs/notes/<topic>.md` at the end of Phases 3, 4, 6, 7 — only what's needed to work with the tech:
- **Ph3:** CRDT/YATA intuition, client IDs & clocks, state vectors, tombstones
- **Ph4:** op log vs snapshot trade-offs
- **Ph6:** cgroups, namespaces, capabilities
- **Ph7:** pub/sub vs streams delivery semantics

---

## END-TO-END VERIFICATION (final demo)

1. `docker compose up -d` → `npm run dev` (web + server + runner).
2. Register two users in two browsers; A creates a project, adds B.
3. Both open `main.py` — type simultaneously, see each other's cursors.
4. Kill the server, restart, reload — text intact.
5. Go offline in one tab, keep typing, return online — converges.
6. Click **Run** — output streams to xterm.js with exit code; then run an infinite loop → TIMEOUT, `docker ps -a` clean.
7. Start a second server instance, point one tab at it — cross-instance sync works.
8. `npm run loadtest -- --clients 200 --hot-doc` → record real percentiles.

---

## RISKS

- **Docker Desktop / WSL2 install is the single hard blocker** for Phase 6 — module 0.1 first, so failures surface on day 0.
- Phase 6 is the biggest single chunk (~8 sessions). If it slips, **Phase 7 is the deferrable one** — module 7.1's seam already exists in 3.3.
- At 3 hrs/day split into pieces, the real risk is losing context between sittings. Mitigated by module-sized work + a commit at every boundary: read the last commit message to know exactly where we are.
- Windows quirks: `core.autocrlf=false` + `.gitattributes` LF normalization before any sandbox script is written.

---

## FUTURE EXPANSION (designed for, not built now)

| Feature | Where it plugs in |
|---|---|
| More languages | 6.1 config entry |
| Container pools | behind 6.3's `runInContainer` |
| Execution history / saved results | new table + 6.6 |
| Chat, comments | new `modules/*` + new Yjs subdocs |
| File/code search, version history, Git integration | new `modules/*` |
| Better sandboxing (seccomp, gVisor) | 6.3 / 6.4 only |
| Horizontal scale-out, Redis Streams | 7.1 already abstracts the bus |
| AI coding assistance | new module consuming `DocStore` + `LANGUAGES` |

---

## PROGRESS TRACKER

Mark these off as you go.

```
Phase 0  [x] 0.1  [x] 0.1b [x] 0.2  [x] 0.3  [x] 0.4   <- PHASE COMPLETE
Phase 1  [ ] 1.1  [ ] 1.2  [ ] 1.3  [ ] 1.4  [ ] 1.5
Phase 2  [ ] 2.1  [ ] 2.2  [ ] 2.3  [ ] 2.4
Phase 3  [ ] 3.1  [ ] 3.2  [ ] 3.3  [ ] 3.4  [ ] 3.5
Phase 4  [ ] 4.1  [ ] 4.2  [ ] 4.3  [ ] 4.4
Phase 5  [ ] 5.1  [ ] 5.2  [ ] 5.3
Phase 6  [ ] 6.1  [ ] 6.2  [ ] 6.3  [ ] 6.4  [ ] 6.5  [ ] 6.6  [ ] 6.7
Phase 7  [ ] 7.1  [ ] 7.2
Phase 8  [ ] 8.1  [ ] 8.2  [ ] 8.3
Phase 9  [ ] 9.1  [ ] 9.2
```

**Phase 0 complete (2026-08-09).** See `docs/plans/phase-0-plan.md` for what was actually built and where reality diverged from the plan (TypeScript 7, Prisma 7's datasource change, project references).

**Next: Phase 1 — Auth, projects, files.** Needs a phase plan written and approved before any code. Two carry-overs first: move Claude Code into WSL, and install `@prisma/adapter-pg` + `pg` (Prisma 7 requires a driver adapter at runtime).
