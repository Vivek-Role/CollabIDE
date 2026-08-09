# CLAUDE.md

Working notes for Claude Code on this repo. Keep it current; keep it short.

## What this is

A real-time collaborative code editor: multiple authenticated users edit a shared
project simultaneously with live cursors, edits survive refresh/offline/reconnect,
and a **Run** button executes code in a resource-limited, network-isolated Docker
container with output streamed to a browser terminal.

Full build plan: `docs/PLAN.md`. Per-phase plans: `docs/plans/phase-N-plan.md`.

## Workflow rules (these override defaults)

1. **Never run `git commit`.** Suggest a message; the user commits. Inspecting
   status/diff is fine.
2. **Plan before each phase.** Write `docs/plans/phase-N-plan.md`, recommend a
   model + effort level, ask the user any decision-affecting questions, then stop
   and wait for approval.
3. **One module per turn**, then stop — unless the user explicitly says to run a
   whole phase straight through (as they did for Phase 0).
4. At phase end: update this file, update the phase plan to what was *actually*
   built, and give a phase summary.

## Environment (this machine)

- **Repo must live on the Linux filesystem**: `~/dev/collab-editor` in WSL2 Ubuntu 26.04.
- Node **24.19.0** via nvm (`.nvmrc` pins 24). Docker Desktop 4.85, engine 29.6.2.
- **Files written from Windows over `\\wsl.localhost` are created as `root`.**
  If Claude Code is running from Windows, run
  `wsl -u root -e chown -R vivek:vivek /home/vivek/dev/collab-editor` after every
  write batch, *before* anything runs as `vivek`. `wsl -u root` needs no password.
  Running Claude Code from inside WSL avoids this entirely — preferred.
- `bash -lc` does **not** load nvm (Ubuntu's `.bashrc` returns early when
  non-interactive). Non-interactive calls need `. $HOME/.nvm/nvm.sh` first.
- `wsl.exe` output through PowerShell drops everything after the first line when
  the command contains double quotes, `$(...)` or parentheses. Redirect to a file
  and read that; lead with an `echo MARKER` line.

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript 7, ESM everywhere (`"type": "module"`, `NodeNext`) |
| Monorepo | npm workspaces + TS project references (`tsc -b`) |
| Frontend | React + Vite + Tailwind, CodeMirror 6, yjs, xterm.js *(from Phase 2)* |
| Backend | Node + Express 5, `jose` (JWT), `zod`, `ws` + `y-protocols` *(3.2)* |
| Tests | Vitest + supertest against a real `collab_editor_test` database |
| Queue | BullMQ on Redis + separate runner worker *(Phase 6)* |
| DB | PostgreSQL 16 + Prisma 7 |
| Cache/bus | Redis 7 |
| Sandbox | Docker CLI driven from the runner *(Phase 6)* |

## Structure

```
apps/web/        React client                                  (stub until 2.1)
apps/server/     REST + WebSocket + collab hub — NEVER touches Docker
apps/runner/     BullMQ worker -> Docker sandbox — NEVER touches HTTP/WS
packages/shared/ types shared by all three; imports from no app
infra/           docker-compose.yml (postgres, redis) + sandbox images later
docs/            PLAN.md, plans/, ARCHITECTURE.md + adr/ later
```

## Invariants — do not break these

- `apps/server` and `apps/runner` **never import each other**. They communicate
  only through the BullMQ queue and Redis channels, with payload types from
  `@collab/shared`.
- User code **never executes in the server process** — only inside a container
  owned by the runner.
- Authorization is enforced **server-side**, never trusted from the client.
  `assertProjectAccess` (module 1.3) is shared by both REST and WebSocket paths.
- Persistence sits behind a `DocStore` interface (4.1) so the backing store is
  swappable in one folder.
- Adding a language is a config entry in `packages/shared` (6.1) — zero code changes.
- Every server module exports through an `index.ts` barrel; cross-module calls go
  through the barrel only.
- No file over ~300 lines.
- Prisma is imported **only** in `apps/server`. The runner reads plain text from
  `File.content`, materialized by module 4.4.

## Server layout (Phase 1)

```
src/index.ts            the only file that calls listen()
src/app.ts              buildApp() -> Express app, no listen (supertest drives this)
src/config.ts           env parsed once by zod at import; refuses to boot if wrong
src/db.ts               the only PrismaClient, via @prisma/adapter-pg
src/http/               errors.ts (AppError + envelope), originCheck.ts, params.ts
src/modules/auth/       password, token, requireAuth, authorize, routes
src/modules/projects/   schemas, service (rules), routes (thin)
src/modules/files/      paths (pure), schemas, service, routes
test/                   *.test.ts + helpers/ (app, auth, db, projects, env, globalSetup)
```

Rules that hold across modules:

- **An explicitly-set env var always beats `.env`.** Both `src/config.ts` and
  `prisma.config.ts` follow this — it is what lets the test harness point at
  `collab_editor_test` instead of wiping your dev data.
- **Every error goes through `AppError` + the error middleware.** One envelope:
  `{ error: { code, message } }`. Handlers `throw`; Express 5 forwards async
  rejections, so no try/catch and no async wrapper.
- `service.ts` holds rules and knows nothing about HTTP; `routes.ts` does
  parse → guard → service → response.
- `req.params[x]` is `string | string[] | undefined` in Express 5 — use
  `routeParam(req, name)` from `src/http/params.ts`, never a cast.
- Tests run **serially** (`fileParallelism: false`): they share one database and
  truncate between cases.

## API surface (Phase 1)

```
POST   /api/auth/register|login|logout      GET /api/auth/me
GET    /api/projects                        POST   /api/projects
GET    /api/projects/:id                    PATCH  /api/projects/:id     (OWNER)
DELETE /api/projects/:id (OWNER)            POST   /api/projects/:id/members (OWNER)
PATCH  /api/projects/:id/members/:userId (OWNER)
DELETE /api/projects/:id/members/:userId (OWNER)
GET    /api/projects/:projectId/files       (VIEWER)   tree
GET    /api/projects/:projectId/files/:fileId (VIEWER) content
POST   /api/projects/:projectId/files       (EDITOR)
PUT    /api/projects/:projectId/files/:fileId (EDITOR) content — scaffolding, see 3.5
PATCH  /api/projects/:projectId/files/:fileId (EDITOR) move/rename
DELETE /api/projects/:projectId/files/:fileId (EDITOR) recursive
```

**404 vs 403:** not a member → **404**, so project existence stays private. 403
means "you are a member but not senior enough". Never change this to a 403.

## Phase 2 must do this first

The session cookie is `SameSite=Strict`. Vite on `:5173` and the API on `:4000`
are **different origins**, so the cookie will not be sent and every request will
401 while login appears to succeed. Module 2.1 must add a **Vite dev proxy** so
the browser sees one origin:

```ts
server: { proxy: { '/api': 'http://localhost:4000' } }   // and '/ws' in 3.2
```

`WEB_ORIGIN` (default `http://localhost:5173`) is the one origin allowed to make
mutating requests.

## Conventions

- Workspace packages are named `@collab/*`.
- `strict: true` plus `noUncheckedIndexedAccess` and `verbatimModuleSyntax`
  (so type-only imports must say `import type`).
- Build and typecheck both run `tsc -b` from the root — with project references,
  building *is* typechecking, and it resolves dependency order automatically.
- Container images are pinned to a major version, never `:latest`.
- `.env` is gitignored; `.env.example` is the committed template.

## Phase status

- **Phase 0 — COMPLETE.** Monorepo, Docker infra, Prisma bootstrap.
- **Phase 1 — COMPLETE.** Data model, server foundation, auth, authorization,
  projects, files. 128 tests passing.
- Phase 2 (editor UI) is next — start with the Vite proxy above.

## Known limitations right now

- **No frontend.** `apps/web` and `apps/runner` are still stubs; Phase 1 is
  verified by tests and curl only.
- **Sessions cannot be revoked before they expire.** One 7-day access token, no
  refresh and no rotation. Logout clears the cookie, but a stolen token stays
  valid. Adding refresh touches only `modules/auth/token.ts`.
- **Membership changes take effect on the next request** — a live session is not
  kicked. Mid-session revocation lands with the WS layer in Phase 3.
- **`PUT .../files/:fileId` is scaffolding.** It exists so Phase 2's editor is
  testable before collaboration; module 3.5 moves editor writes to Yjs and 4.4
  becomes the writer of `File.content`.
- `DocUpdate` / `DocSnapshot` exist but are never written until Phase 4.
- No rate limiting, password reset, email verification, or pagination.
- The login timing equaliser is a dummy scrypt of the same cost, not a formal
  constant-time guarantee.
- `apps/web` still uses `NodeNext` resolution; module 2.1 switches it to bundler
  resolution when Vite arrives.
- Claude Code is being run from Windows, so the `chown` rule above applies.
- npm's `allow-scripts` gate leaves Prisma's and esbuild's install scripts
  unapproved. Harmless so far — everything works.
