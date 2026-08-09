# Phase 1 — Summary

**Phase:** 1 — Auth, Projects, Files
**Status:** ✅ Complete — 2026-08-09
**Committed:** No. Nothing was committed; all commits are the user's to make.

---

## Modules completed

| # | Module | Tests | Result |
|---|---|---|---|
| 1.1 | Data model | — | 7 models + `Role` enum, migration `20260809100854_phase1_models` |
| 1.1b | Server runtime foundation *(added — see deviations)* | 6 | Express 5 boots, Prisma driver adapter works, Vitest harness live |
| 1.2 | Auth module | 17 | scrypt hashing, `jose` cookie sessions, `requireAuth` |
| 1.3 | Authorization module | 14 | `assertProjectAccess` — transport-agnostic, ready for 3.4 |
| 1.4 | Projects API | 24 | CRUD + member management |
| 1.5 | Files API | 67 | 37 pure path tests + 30 integration |

**128 tests, all passing.**

---

## What was built

The stub server became a running, authenticated, permission-enforcing backend.

```
apps/server/src/
  index.ts            the only file that calls listen(); graceful SIGINT/SIGTERM
  app.ts              buildApp() -> Express app, no listen (supertest drives it)
  config.ts           env parsed once by zod at import; refuses to boot if wrong
  db.ts               the only PrismaClient, via @prisma/adapter-pg
  http/               errors.ts (AppError + one envelope), originCheck.ts, params.ts
  modules/auth/       password · token · requireAuth · authorize · routes
  modules/projects/   schemas · service (rules) · routes (thin)
  modules/files/      paths (pure) · schemas · service · routes
apps/server/test/     6 suites + helpers (app, auth, db, projects, env, globalSetup)
```

**API surface**

```
POST   /api/auth/register|login|logout       GET /api/auth/me
GET    /api/projects                         POST   /api/projects
GET    /api/projects/:id            VIEWER   PATCH  /api/projects/:id       OWNER
DELETE /api/projects/:id            OWNER    POST   /api/projects/:id/members  OWNER
PATCH  /api/projects/:id/members/:userId     OWNER
DELETE /api/projects/:id/members/:userId     OWNER
GET    /api/projects/:projectId/files                 VIEWER   nested tree
GET    /api/projects/:projectId/files/:fileId         VIEWER   content
POST   /api/projects/:projectId/files                 EDITOR
PUT    /api/projects/:projectId/files/:fileId         EDITOR   scaffolding — see 3.5
PATCH  /api/projects/:projectId/files/:fileId         EDITOR   move/rename
DELETE /api/projects/:projectId/files/:fileId         EDITOR   recursive
```

**Data model:** `User`, `Project`, `ProjectMember`, `Role(OWNER|EDITOR|VIEWER)`, `File`,
`DocUpdate`, `DocSnapshot`. The two doc tables exist but stay empty until Phase 4.

---

## Technologies added

Express 5 · `jose` (JWT) · `zod` · `cookie-parser` · `@prisma/adapter-pg` + `pg` ·
`node:crypto` scrypt · Vitest 4 + supertest · `tsx` (dev watch).

Still absent: React, Vite, Tailwind, CodeMirror, Yjs, `ws`, BullMQ, Docker sandbox.
Redis sits idle in Compose until Phase 6.

---

## Verified checks

| Check | Result |
|---|---|
| `npm run build` / `typecheck` / `typecheck:test` | exit **0** |
| `npx vitest run` | **128/128 pass** across 6 suites |
| `/health` against live Postgres | `200 {"ok":true}` — proves the driver adapter |
| Register Alice + Bob (real HTTP, cookie jars) | 201, 201 |
| Bob reads Alice's project **before** invite | **404** — existence hidden |
| Alice invites Bob as EDITOR | 201 |
| Bob creates `src/main.py` | 201 — parent `src/` created implicitly |
| Alice reads the tree | 200, correctly nested |
| `../../etc/passwd` | **400 INVALID_PATH**, nothing written |
| No cookie on `/api/projects` | **401 UNAUTHENTICATED** |
| Bob (EDITOR) deletes the project | **403 FORBIDDEN** |
| Wrong password vs unknown email | byte-identical 401, timing equalised |
| Stored password | `scrypt$32768$8…` — plaintext appears nowhere |
| `SIGINT` | exit **0** |
| `find . ! -user vivek` (excl. `node_modules`) | no output |

---

## Key decisions

| Decision | Why |
|---|---|
| JWT in an **httpOnly `SameSite=Strict` cookie** | XSS cannot read it — and it removes the `?token=` query param the original plan had for the WS handshake in 3.2, since the browser sends the cookie on upgrade |
| **OWNER / EDITOR / VIEWER** | VIEWER creates a real read-only path for 3.4 to enforce; adding it later would mean a migration |
| **404, not 403, for a non-member** | A 403 confirms the project exists and lets anyone enumerate project ids. 403 is reserved for "member, but not senior enough" |
| `assertProjectAccess` takes **plain strings, returns plain data** | Module 3.4 calls it during a WebSocket upgrade where no Express request exists |
| **scrypt** from `node:crypto` | No native build, no compile step; parameters stored inside the hash so cost can be raised later |
| **`jose`** over `jsonwebtoken` | ESM-native and dependency-free under `verbatimModuleSyntax` + NodeNext |
| **`buildApp()` never calls `listen`** | supertest drives the app object — no ports, no races |
| **Separate `collab_editor_test` database** | The `_test` suffix is re-checked before every truncate, so dev data cannot be wiped |
| Explicit env var **beats `.env`** | Lets the harness and CI redirect `DATABASE_URL` safely |
| Project create is **one transaction** | A project without its OWNER row is one nobody can open — including its creator |
| Flat file rows, **tree built in memory** | One indexed query, O(n); keeps `@@unique([projectId, path])` as the single collision guard |
| Invalid paths **rejected, never sanitized** | Silently rewriting `a/./b` makes client and server disagree about what exists |

---

## Deviations from the plan

1. **`prisma.config.ts` had to be fixed** — it called `process.loadEnvFile()`
   unconditionally, overwriting an already-set `DATABASE_URL`. The test harness's
   `migrate deploy` would have silently migrated the **dev** database. Now guarded.
2. **Added `src/http/params.ts`** — Express 5 types `req.params[name]` as
   `string | string[] | undefined`; six call sites failed to build in 1.4. Notably
   **every test still passed** — vitest transpiles without typechecking.
3. **Added `tsconfig.test.json` + `typecheck:test`** — `tsc -b` compiles only `src/`,
   so test code would never be typechecked. Point 2 is exactly why that matters.
4. **Added `tsx`** for dev watch mode; Node's native type stripping would require
   `.ts` import specifiers, conflicting with the emit build.
5. **Login timing fixed mid-module** — measured 188 ms (wrong password) vs 301 ms
   (unknown email) because the dummy hash was built lazily. Warmed at startup; after:
   `0.148/0.148`, `0.155/0.220`, `0.152/0.147`.
6. **Path prefix matching in JavaScript, not SQL `LIKE`** — a real path may contain
   `%` or `_`, which are LIKE wildcards. `100%.py` is an explicit test case.
7. **`GET` on a directory → 400 `IS_DIRECTORY`**, symmetric with `PUT`. Unspecified
   in the plan.
8. **`CANNOT_REMOVE_SELF` split out from `LAST_OWNER`** — same 409, different message,
   because they tell the user different things.
9. **Files router mounted before the projects router**, so the more specific path wins.

---

## Known limitations

- **No frontend.** Verified by tests and curl only.
- **Sessions cannot be revoked before expiry** — one 7-day token, no refresh, no
  rotation. Logout clears the cookie; a stolen token stays valid.
- **Membership changes apply on the next request** — live sessions are not kicked.
  Mid-session revocation lands with the WS layer in Phase 3.
- **`PUT .../files/:fileId` is scaffolding**, replaced as the editor's write path by
  Yjs in 3.5; 4.4 becomes the writer of `File.content`.
- `DocUpdate` / `DocSnapshot` are never written until Phase 4.
- No rate limiting, password reset, email verification, or pagination.
- The timing equaliser is a dummy scrypt of equal cost, **not** a formal
  constant-time guarantee.
- npm's `allow-scripts` gate leaves Prisma's and esbuild's install scripts unapproved
  — harmless so far.

---

## Carry-overs into Phase 2

1. **The Vite dev proxy is mandatory, and it is module 2.1's first job.** Vite on
   `:5173` and the API on `:4000` are different origins, so a `SameSite=Strict` cookie
   is not sent: login would appear to succeed and every later request would 401.
   ```ts
   server: { proxy: { '/api': 'http://localhost:4000' } }   // and '/ws' in 3.2
   ```
2. `apps/web` still uses `NodeNext` resolution — 2.1 switches it to bundler resolution.
3. Claude Code is still running from Windows, so `wsl -u root chown -R vivek:vivek …`
   after every write batch still applies. Moving into WSL ends that.
4. `main` still has **zero commits** — Phase 0 and Phase 1 are both untracked.

---

## Commits to make (six, uncommitted)

```
feat(db): add user, project, member, file and doc models
feat(server): add express bootstrap, prisma adapter and test harness
feat(auth): add scrypt password hashing, jwt cookie sessions and requireAuth
feat(auth): add role-ranked project authorization shared by rest and ws
feat(projects): add project crud and member management
feat(files): add project file tree with path validation and recursive ops
```

---

## Next phase

**Phase 2 — Editor shell** (modules 2.1–2.4): Vite + Tailwind app shell and auth UI,
project list, file tree, CodeMirror pane. Requires a written, approved
`docs/plans/phase-2-plan.md` before any code is written.
