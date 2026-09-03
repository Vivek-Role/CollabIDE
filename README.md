# collab-editor

A real-time collaborative code editor — multiple authenticated users edit a shared project
simultaneously with live cursors, edits survive refresh, offline and reconnection, and a
**Run** button executes the code inside a resource-limited, network-isolated Docker container
with output streamed to a browser terminal.

> **Status: feature-complete for its plan, and locally runnable.** Not deployed anywhere, and
> there is no deployment configuration in this repository — see
> [Honest limitations](#honest-limitations).

**[Architecture](docs/ARCHITECTURE.md)** · **[Setup](docs/SETUP.md)** ·
**[API](docs/API.md)** · **[Database](docs/DATABASE.md)** ·
**[Real-time collaboration](docs/REALTIME.md)** · **[Code execution & sandbox](docs/EXECUTION.md)** ·
**[Security & limitations](docs/SECURITY.md)** · **[Why each choice](docs/adr/README.md)**

---

## The problem

Editing code together usually means one of two compromises: take turns and merge afterwards, or
adopt a hosted platform and give up control of where the code lives and what runs it. And even
when live editing works, *running* the code is somebody else's problem — so the loop of "write
together, run it, see the output" is broken in the middle.

This project closes that loop on infrastructure you own:

1. **Concurrent editing that actually converges**, without locking, without last-write-wins, and
   without losing work to a dropped connection — including edits made while completely offline.
2. **Running the shared code safely**, in a container that has no network, no host filesystem
   access, no database credentials, bounded CPU, memory, processes and wall clock — with output
   streaming back live.

---

## Key features

- **Real-time collaborative editing** with per-file documents, live remote cursors and a
  presence facepile.
- **Accounts, projects and per-project roles** — `OWNER` / `EDITOR` / `VIEWER`, enforced
  server-side on both REST and the WebSocket. A VIEWER is admitted read-only, and their writes
  are dropped by the server, not just hidden by the UI.
- **Live revocation** — a role change, a removal or a delete closes the affected sockets
  immediately (within one instance).
- **Durable documents** — an append-only log of Yjs binary updates in PostgreSQL, with periodic
  snapshots and safe compaction. A hard kill costs at most ~2 seconds of typing.
- **Offline editing and self-healing reconnection** — keep typing with the network off; the
  document is stored locally and re-synced on reconnect with jittered backoff. There is no
  offline outbox, by design.
- **Multi-instance collaboration** — two server instances sharing one Redis and one Postgres
  converge over a document bus.
- **Sandboxed code execution** — Python and JavaScript, queued to a separate worker process that
  is the sole owner of the Docker socket, with output streamed to an xterm terminal.
- **Client-side project search** — file names instantly, file contents on demand, with keyboard
  shortcuts and honest reporting when a project is too large to scan fully.
- **A file tree** with create, rename, move and recursive delete, and strict path validation.
- **A measured load harness** with 19 committed result blobs.

---

## Technology

| Layer | Choice |
|---|---|
| Language | TypeScript 7, ESM everywhere, `strict` + `noUncheckedIndexedAccess` |
| Monorepo | npm workspaces + TS project references (`tsc -b`) |
| Frontend | React 19, Vite, Tailwind v4, CodeMirror 6, yjs + y-codemirror.next, y-indexeddb, xterm.js |
| Backend | Node 24, Express 5, `ws` + `y-protocols` + `lib0`, `jose` (JWT), `zod` |
| Database | PostgreSQL 16 + Prisma 7 |
| Queue / cache / bus | Redis 7 — BullMQ queue, document channels, run channels |
| Sandbox | Docker CLI, driven from a dedicated worker process |
| Tests | Vitest + supertest against a real database |

---

## Architecture at a glance

```
apps/web/        React client — editor, file tree, presence, terminal, search
apps/server/     REST + WebSocket + collaboration hub   (never touches Docker)
apps/runner/     BullMQ worker -> Docker sandbox        (never touches HTTP/WS)
packages/shared/ types shared by all three, with zero dependencies
loadtest/        headless Yjs load harness
infra/           docker-compose (postgres, redis) + the two sandbox images
docs/            the documentation set, ADRs, notes and diagram sources
```

**Two boundaries define the system, and neither may be crossed:**

1. **`apps/server` and `apps/runner` never import each other.** They communicate only through the
   BullMQ queue and Redis channels, using payload types from `@collab/shared`. Access to the
   Docker socket is effectively root on the host, which is why it lives in a process that serves
   no HTTP.
2. **User code never executes in the server process** — only inside a container owned by the
   runner.

Full component map, module layout and data flow: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## The two mechanisms

They are deliberately separate — they share authentication, the database and a Redis server, and
nothing else. Run output never travels on the collaboration socket.

### 1. Real-time collaboration → [docs/REALTIME.md](docs/REALTIME.md)

**Yjs does the merging. This project did not implement a CRDT.** What was built around it is the
part that makes it a system: a hand-written `y-protocols` WebSocket server authenticated by the
session cookie; per-document authorization sharing exactly one function with the REST layer; a
refcounted room registry; an append-only `DocStore` with snapshots and cross-instance-safe
compaction; a Redis document bus with two echo guards; and the client's offline gate and
reconnection policy.

```
Browser A ──edit──▶ Server 1 ──local fan-out first──▶ Browser B
                        └──PUBLISH doc:<docId>──▶ Redis ──▶ Server 2 ──▶ Browser C
                        └──buffer, 2 s debounce──▶ ONE DocUpdate row ──▶ PostgreSQL
```

### 2. Code execution → [docs/EXECUTION.md](docs/EXECUTION.md)

```
Run ─▶ POST /run (EDITOR) ─▶ flush documents ─▶ SUBSCRIBE ─▶ BullMQ ─▶ 202 {jobId}
    ─▶ runner ─▶ docker create/cp/start ─▶ PUBLISH frames ─▶ SSE ─▶ terminal
```

10-second wall clock, 1 MB of output, 256 MB of memory, 0.5 CPU, 64 processes, no network, a
read-only root filesystem and a non-root user. Exactly one `exit` frame ends every run, on every
path.

---

## Quickstart

Full instructions, environment variables, the two-instance stack and troubleshooting:
**[docs/SETUP.md](docs/SETUP.md)**.

**Requirements:** WSL2 (Ubuntu) with the repo on the **Linux** filesystem, **Node ≥ 24**, and
Docker Desktop with WSL integration. PostgreSQL, Redis and both language runtimes come from
containers; nothing else is installed on the host.

```bash
nvm use && npm install
cp .env.example apps/server/.env          # edit JWT_SECRET before anything leaves your machine
docker compose -f infra/docker-compose.yml up -d

cd apps/server && npx prisma generate && npx prisma migrate deploy && cd ../..
npm run build
```

> `prisma generate` is **not** optional on a fresh clone — npm's `allow-scripts` gate leaves
> Prisma's postinstall unapproved, so `@prisma/client` exports nothing and the build fails.

Then three terminals, or two if you do not need the Run button:

```bash
npm run dev:server     # :4000  REST + WebSocket
npm run dev:web        # :5173  the UI
npm run dev:runner     # the sandbox worker
```

With the server up, seed the demo — it talks to the live REST and WebSocket surfaces exactly as
a browser does, including a real Yjs write. There is no database back door:

```bash
npm run seed:demo
bash infra/images/build.sh     # required for the Run button
```

Open **<http://localhost:5173>** and log in as `demo@example.com` / `demo-password` (or
`alex@example.com`, same password).

> **Always go through `:5173`.** The session cookie is `httpOnly; SameSite=Strict` and Vite
> proxies `/api` and `/ws` so the browser sees one origin. Bypass the proxy and login appears to
> succeed while every later request 401s.

**Setup takes 17 seconds** end to end — measured on 2026-08-15 with a warm npm cache and the
images already pulled. Caveats and splits in [docs/SETUP.md](docs/SETUP.md) §11.

---

## The 60-second tour

1. Open `main.py`. It already has code, because the seed typed it in over the real collaboration
   socket.
2. **Collaboration** — open the same project in a second browser profile as `alex@example.com`,
   open the same file, and type in both. Live carets, no conflicts.
3. **Run** — click **Run main.py**. Output streams into the terminal with an exit code. Then try
   `while True: pass` and watch it time out at 10 seconds with the container gone.
4. **Offline** — DevTools → Network → Offline. Keep typing; the status line says *Reconnecting…*
   and the editor still works. Go back online and both tabs converge.
5. **Search** — `Ctrl/Cmd+K` for everything, `Ctrl/Cmd+P` for file names, `Ctrl/Cmd+Shift+F` for
   contents, `?` for the shortcut list.
6. **Durability** — kill the server (`Ctrl-C`), restart it, reload. The text is there. A hard
   `kill -9` costs at most the last ~2 seconds of typing.

---

## Scripts

| Command | Does |
|---|---|
| `npm run build` | `tsc -b` across shared, server and runner in dependency order |
| `npm run build:web` | Vite production build of the client |
| `npm run typecheck` | The same graph, plus the web and loadtest workspaces |
| `npm test` | The server suite — **245 tests** against a real `collab_editor_test` database |
| `npm run seed:demo` | Creates the demo users, project and file content |
| `npm run loadtest -- --help` | The load harness (see [`docs/notes/loadtest-results.md`](docs/notes/loadtest-results.md)) |
| `npm run clean` | Remove build output |

---

## Honest limitations

The complete, evidenced list is in **[docs/SECURITY.md](docs/SECURITY.md)**. The five worth
knowing before you run it:

- **The sandbox is a reasonable local sandbox, not production-grade isolation.** Shared kernel,
  Docker's default seccomp only, no user namespaces, no gVisor. **A kernel exploit escapes it.**
- **There is no rate limiting anywhere**, and a session cannot be revoked before its 7-day
  expiry.
- **Run routing is single-instance**, and revocation does not cross instances.
- **Capacity is unmeasured.** The load generator saturates this machine's four cores before the
  server does, so the published numbers describe propagation latency, not how many users the
  system supports.
- **Never deployed, and no deployment configuration exists.** The only Dockerfiles in this
  repository are the two sandbox images for user code; `infra/docker-compose.yml` starts
  PostgreSQL and Redis only. There is no CI.

**Testing, stated plainly:** 245 tests, **all of them `apps/server` tests**. There are no
frontend tests and no runner tests — the part that executes untrusted code has no automated
coverage, and its safety behaviour was verified manually once, on 2026-08-14
([`docs/notes/sandbox-tests.md`](docs/notes/sandbox-tests.md)).
