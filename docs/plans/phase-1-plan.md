# Phase 1 Plan — Auth, Projects, Files

> Branch: `feat/auth-projects-files` · ~5–6 sessions · Awaiting approval.
> On completion this file is rewritten to record what was *actually* built.

---

## Context

Phase 0 delivered an environment: a workspace monorepo, Postgres + Redis healthy in
Compose, and a Prisma baseline with **no models**. Every workspace `src/index.ts` is
still a stub. Nothing executes.

Phase 1 turns that into a running backend: real database models, an authenticated
user, a project owned by that user, and a file tree inside it. It is the first phase
that produces code another phase depends on — Phase 2's UI talks to these routes, and
Phase 3's WebSocket layer reuses this phase's authorization function verbatim.

**Why this phase exists:** the collaborative editor is meaningless without an identity
to attach a cursor to and a permission boundary around a document. Both are built
here, once, server-side.

---

## State audit — where we actually are

| # | Finding | Evidence | Consequence for Phase 1 |
|---|---|---|---|
| **S1** | `schema.prisma` has **datasource + generator only** | `apps/server/prisma/schema.prisma:15-21` | 1.1 writes every model from scratch — no migration conflicts to manage |
| **S2** | **`PrismaClient` cannot be constructed yet.** Prisma 7 removed `url` from `datasource`; the runtime requires a driver adapter | `CLAUDE.md:103-106`, phase-0 deviation #2 | `@prisma/adapter-pg` + `pg` must be installed and wired **before** any module queries the DB. This is why module 1.1b exists |
| **S3** | `apps/server` has **no runtime dependencies** — no Express, no HTTP server | `apps/server/package.json:8-14` | The server does not start. 1.1b builds the bootstrap |
| **S4** | `JWT_SECRET` placeholder already reserved in `.env.example` | `.env.example:20` | Shape is agreed; 1.2 gives it a real generated value locally |
| **S5** | ESM + `verbatimModuleSyntax` + `noUncheckedIndexedAccess` are on | `tsconfig.base.json:12,18` | Dependencies must be ESM-clean, and `import type` is mandatory for types. Drives the `jose` choice in 1.2 |
| **S6** | Root `build`/`typecheck` are both `tsc -b` via project references | `package.json:15-17` | A new workspace dependency needs its `references` entry or it silently won't rebuild |
| **S7** | **Claude Code is still running from Windows.** The Phase 0 plan deferred the move into WSL to "before Phase 1" — it has not happened | `CLAUDE.md:109` | The `wsl -u root chown` rule applies after every write batch for this phase too, unless we move first |
| **S8** | Baseline migration `20260808203715_init` is empty and applied | `prisma/migrations/` | 1.1's migration stacks cleanly on top; no reset needed |

**S2 is the blocking one.** It is a Prisma 7 breaking change, not a mistake, and it
turns "add models" into "add models *and* wire a driver adapter". Splitting that into
1.1b keeps both changes reviewable.

**S7 is the one to decide before we start** — see *Open items* below.

---

## Decisions locked in

Four came from your answers this session; the rest follow from the audit.

| Decision | Choice | Rationale |
|---|---|---|
| **JWT transport** | **httpOnly cookie** (`ce_session`, `SameSite=Strict`, `Secure` off in dev) | XSS cannot read the token. Also **removes the `?token=` query param** the master plan had for the WebSocket handshake in 3.2 — the browser sends the cookie on upgrade automatically, so the JWT never appears in a URL or a proxy log |
| **Roles** | **`OWNER` / `EDITOR` / `VIEWER`** | VIEWER creates a genuine read-only path to enforce in 3.4 (accept sync, reject updates) — the most interesting authorization case in the project, for ~10 lines now instead of a migration later |
| **Testing** | **Vitest + supertest, from 1.2 onward** | Every "Done when" becomes self-checking. Auth and authorization are exactly where a silent regression is expensive |
| **Commits** | **You commit. I never run `git commit`.** | Your standing workflow. Supersedes `docs/PLAN.md:120` and `:313`, which still say Claude commits |
| **CORS / origin** | **Vite dev-proxies `/api` and `/ws` to `:4000`** | A consequence of the cookie choice — see the callout below |
| **JWT library** | **`jose`** | ESM-native, zero dependencies. `jsonwebtoken` is CJS and pulls a tree; under `verbatimModuleSyntax` + `NodeNext`, `jose` is simply less friction |
| **Validation** | **`zod`** at every route boundary | Request bodies are untrusted input; parsed once, into typed objects. Also gives 1.5's path rules a single home |
| **Password hashing** | **`scrypt`** from `node:crypto` | Per the master plan. No native build, no `bcrypt` compile step, and `timingSafeEqual` is right there |
| **File storage** | Full `path` string per row + `isDir` flag | Tree assembled in memory. Simpler than adjacency lists for a project-sized tree, and 4.4 materializes text into the same `content` column |
| **New module 1.1b** | Server runtime foundation | Forced by S2 + S3. Without it, module 1.2 would silently be three modules of work |

> ### ⚠️ The cookie choice has one consequence worth understanding now
>
> In dev, Vite serves the UI on `:5173` and the API listens on `:4000`. Those are
> **different origins**, and a `SameSite=Strict` cookie is not sent across them — login
> would appear to succeed and every subsequent request would be a 401.
>
> The fix is a **Vite dev proxy**: the client calls same-origin `/api/...`, Vite forwards
> it to `:4000`. The browser then sees one origin, the cookie flows normally, and the
> same-origin rule also neutralizes most CSRF for free. Phase 1 assumes this and
> **module 2.1 must configure it** — I'll add the note to `CLAUDE.md` at phase end so
> it isn't rediscovered painfully. As a belt-and-braces measure, 1.1b also adds an
> `Origin`-header check on mutating requests.

---

## Model + effort recommendation

**Recommendation for most of Phase 1: Sonnet 5 at medium effort.**

Phase 1 is careful CRUD with a security boundary. It is well-trodden work where
correctness comes from being methodical across many small files, not from novel
reasoning — Opus 5 would not write a better `requireAuth`. Two modules earn more:
1.3 because it is the one function the entire project's security rests on and is
reused untouched by the WebSocket layer, and 1.5 because path handling is where
subtle bugs hide (traversal, prefix renames, orphaned descendants).

| Module | Model | Effort | Why |
|---|---|---|---|
| 1.1 Data model | Sonnet 5 | **Medium** | Schema shape is consequential and hard to change after data exists, but it is fully specified below |
| 1.1b Runtime foundation | Sonnet 5 | **Medium** | Adapter wiring is fiddly (S2) and the test harness must be right the first time |
| 1.2 Auth module | Sonnet 5 | **Medium–High** | Crypto handled by stdlib, but cookie flags, expiry and error shapes reward care |
| 1.3 Authorization | Sonnet 5 | **High** | ~40 lines that every later phase trusts. Cheap to get right now, expensive later |
| 1.4 Projects API | Sonnet 5 | **Medium** | Routine CRUD once 1.3 exists |
| 1.5 Files API | Sonnet 5 | **High** | Path normalization, collisions, recursive rename/delete, traversal defense |

**Still saving Opus 5 + high effort for Phase 3 (Yjs sync/awareness), Phase 4
(persistence + compaction) and Phase 6 (sandbox isolation)** — the three places with
real distributed-systems and isolation reasoning.

---

## Modules

Six modules, each one sitting. Dependencies are strictly linear: **1.1 → 1.1b → 1.2 →
1.3 → 1.4 → 1.5**.

---

### Module 1.1 — Data model

**Depends on:** Phase 0 complete.

**Files:** `apps/server/prisma/schema.prisma` (rewritten), new migration
`prisma/migrations/<ts>_phase1_models/`.

**Models**

| Model | Fields | Notes |
|---|---|---|
| `User` | `id` (cuid), `email` (unique, lowercased), `passwordHash`, `displayName`, `createdAt` | No `role` — global roles aren't needed; permissions are per-project |
| `Project` | `id`, `name`, `ownerId → User`, `createdAt`, `updatedAt` | `ownerId` is denormalized convenience; the OWNER `ProjectMember` row is still the source of truth |
| `ProjectMember` | `id`, `projectId`, `userId`, `role: Role`, `createdAt`, `@@unique([projectId, userId])` | The join table 1.3 reads on every request |
| `Role` (enum) | `OWNER` \| `EDITOR` \| `VIEWER` | Ordered by privilege in code, not in SQL |
| `File` | `id`, `projectId`, `path`, `content` (String, default `""`), `isDir` (Bool), `createdAt`, `updatedAt`, `@@unique([projectId, path])` | `path` is the full POSIX path from project root, no leading slash |
| `DocUpdate` | `id` (BigInt autoincrement), `docId`, `update` (Bytes), `createdAt`, `@@index([docId, id])` | Written from Phase 4. Created now so the schema is one reviewable change |
| `DocSnapshot` | `id`, `docId` (unique), `snapshot` (Bytes), `updateId` (BigInt), `createdAt` | Ditto |

**Key implementation decisions**

- **`DocUpdate` / `DocSnapshot` are created now but unused until Phase 4.** The master
  plan lists them in 1.1 and it's right: one migration for the whole data model beats
  a schema smeared across four phases.
- **`onDelete: Cascade`** from `Project` to `ProjectMember`, `File`. Deleting a project
  must not strand rows. `DocUpdate`/`DocSnapshot` key on a string `docId`
  (`${projectId}:${fileId}`) and so are cleaned up explicitly in Phase 4, not by FK.
- **Email stored lowercased** at write time, with a plain unique index — avoids
  citext and the "two accounts differing only in case" bug.
- **`content` on `File`** starts as `""`. It is REST-owned scaffolding in Phase 2 and
  becomes the materialization target in 4.4 — the column doesn't change, only who writes it.
- `BigInt` for `DocUpdate.id`: an append-only log per keystroke-batch will exhaust an
  `Int` on a busy doc, and changing a PK type later is genuinely painful.

**Done when:** `npx prisma migrate dev --name phase1_models` applies cleanly ·
`npx prisma generate` succeeds · all seven models visible in `npx prisma studio` ·
`npm run typecheck` exits 0 · `docker compose down && up -d` → `migrate status` reports up to date.

**Suggested commit:** `feat(db): add user, project, member, file and doc models`

---

### Module 1.1b — Server runtime foundation *(new — forced by S2 and S3)*

**Why it exists:** the server currently has no HTTP layer and *cannot construct a
Prisma client at all* (S2). Folding that into 1.2 would make the auth module a
three-in-one change that nobody could review. This module makes the server boot,
connect, and be testable — and adds no features.

**Depends on:** 1.1.

**Files**

```
apps/server/src/index.ts            # rewritten: boot, listen, graceful shutdown
apps/server/src/app.ts              # buildApp() -> Express app, no listen()
apps/server/src/config.ts           # env parsed + validated by zod, once
apps/server/src/db.ts               # PrismaClient + @prisma/adapter-pg  (S2)
apps/server/src/http/errors.ts      # AppError + central error middleware
apps/server/src/http/originCheck.ts # Origin guard on mutating requests
apps/server/test/helpers/           # test app factory + DB reset
apps/server/vitest.config.ts
```

**Dependencies added:** `express@5`, `cookie-parser`, `zod`, `@prisma/adapter-pg`, `pg`
· dev: `vitest`, `supertest`, `@types/express`, `@types/supertest`, `@types/pg`.

**Key implementation decisions**

- **`buildApp()` returns the app without listening.** supertest drives the app object
  directly — no ports, no races, tests run in parallel safely. `index.ts` is the only
  file that calls `listen`.
- **Config is parsed once, at boot, by zod.** A missing `JWT_SECRET` should crash on
  startup with a clear message, not produce a 500 on the first login three days later.
  Uses Node 24's `process.loadEnvFile()`, consistent with `prisma.config.ts` — still no `dotenv`.
- **Driver adapter (S2):** `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`,
  exported as a single shared instance. One pool for the process.
- **Central error middleware.** Routes `throw new AppError(status, code, message)`;
  one place converts that to `{ error: { code, message } }`. Prisma's `P2002` maps to
  409, `P2025` to 404. Stack traces never cross the wire.
- **Test database is a separate database on the same container** (`collab_editor_test`),
  created by the harness and migrated with `prisma migrate deploy`. Tests truncate
  tables between cases. Dev data is never touched.
- **Origin check** on `POST`/`PATCH`/`DELETE`: reject if `Origin` is present and not in
  the allowlist. Cheap second line of defense behind `SameSite=Strict`.
- Health route `GET /health` → `{ ok: true }` after a `SELECT 1`, proving the adapter works end to end.

**Done when:** `npm run dev -w @collab/server` starts and `curl localhost:4000/health`
returns `{"ok":true}` · `npx vitest run` passes a smoke test that boots the app and hits
`/health` against the test DB · a missing `JWT_SECRET` fails at boot with a readable
error · `SIGINT` disconnects Prisma and exits 0 · `npm run typecheck` exits 0.

**Suggested commit:** `feat(server): add express bootstrap, prisma adapter and test harness`

---

### Module 1.2 — Auth module

**Depends on:** 1.1b.

**Files:** `apps/server/src/modules/auth/` — `password.ts`, `token.ts`, `requireAuth.ts`,
`routes.ts`, `index.ts` (barrel) · `test/auth.test.ts`.

**Exposes:** `requireAuth`, `signToken`, `verifyToken`, `authRouter`.

**Routes**

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/auth/register` | `{ email, password, displayName }` | 201 + user, sets `ce_session` |
| `POST` | `/api/auth/login` | `{ email, password }` | 200 + user, sets `ce_session` |
| `POST` | `/api/auth/logout` | — | 204, clears the cookie |
| `GET` | `/api/auth/me` | — | 200 + user, or **401** |

**Key implementation decisions**

- **scrypt**, salt 16 random bytes, `N=2**15, r=8, p=1`, 64-byte key, stored as
  `scrypt$N$r$p$<salt-b64>$<hash-b64>`. The parameters live *in* the string so they can
  be raised later without invalidating existing hashes. Verification uses `timingSafeEqual`.
- **The cookie:** `httpOnly`, `sameSite: 'strict'`, `path: '/'`, `secure` only when not
  dev, `maxAge` 7 days. JWT payload is `{ sub, email }` with a matching `exp`, HS256 via `jose`.
- **No refresh token in Phase 1.** One 7-day access token; logout clears the cookie.
  Documented residual limitation: **a stolen token cannot be revoked before expiry.**
  Adding refresh + rotation later touches only this module.
- **Login and register return identical timing and an identical error** for
  "no such email" and "wrong password" — `401 INVALID_CREDENTIALS`. An unknown email
  still runs a dummy scrypt so response time doesn't enumerate accounts.
- **Password rule:** minimum 10 characters, no composition rules. Length beats symbol soup.
- `requireAuth` reads the cookie, verifies, loads the user, sets `req.user`; **401 and
  nothing else** on any failure. It never consults project membership — that is 1.3's job,
  and keeping the two separate is what lets 3.4 reuse 1.3 alone.

**Done when:** register → login → `GET /api/auth/me` returns the user, driven by tests ·
duplicate email → 409 · wrong password → 401 with the same body and shape as unknown email ·
the response `Set-Cookie` carries `HttpOnly; SameSite=Strict` · `/api/auth/me` without a
cookie → 401 · a tampered JWT → 401 · logout then `/me` → 401 · **`passwordHash` never
appears in any response body** (asserted in a test).

**Suggested commit:** `feat(auth): add scrypt password hashing, jwt cookie sessions and requireAuth`

---

### Module 1.3 — Authorization module

> The master plan calls this out deliberately, and it's the right call: **the same
> function is reused unchanged by the WebSocket layer in module 3.4.** Backend-enforced,
> never trusted from the client (`CLAUDE.md:72-73`).

**Depends on:** 1.2.

**Files:** `apps/server/src/modules/auth/authorize.ts` · `test/authorize.test.ts`.

**Exposes:** `assertProjectAccess(userId, projectId, minRole): Promise<ProjectMember>`,
`ROLE_RANK`, `requireProjectRole(minRole)` (an Express wrapper over the same function).

**Key implementation decisions**

- **One function, two callers.** The core is transport-agnostic — no `req`, no `res`, no
  Express types — precisely so 3.4 can `await` it during a WebSocket upgrade. The Express
  middleware is a thin wrapper. This is the module's whole point.
- **Rank comparison:** `{ VIEWER: 0, EDITOR: 1, OWNER: 2 }`, and access is
  `rank(actual) >= rank(required)`. Adding a role later is one entry.
- **404, not 403, for a project you are not a member of.** A 403 confirms the project
  exists; enumerating other users' project IDs is a real leak. 403 is reserved for
  "you are a member, but not senior enough" — where the existence is already known to you.
- **Returns the membership row**, so callers get the role without a second query.
- One indexed query on `@@unique([projectId, userId])`. No caching in Phase 1 — correctness
  first; if it shows up in Phase 8 profiling it's a one-line memo away.

**Done when:** a second user gets **403/404 as specified** on another's project (tested) ·
VIEWER passes `minRole: VIEWER`, **fails** `EDITOR` · OWNER passes all three · a
nonexistent project id → 404 · the function is importable and callable **with no Express
request object** (asserted directly in a unit test — this is what proves 3.4 can use it).

**Suggested commit:** `feat(auth): add role-ranked project authorization shared by rest and ws`

---

### Module 1.4 — Projects API

**Depends on:** 1.3.

**Files:** `apps/server/src/modules/projects/` — `service.ts`, `routes.ts`, `schemas.ts`,
`index.ts` · `test/projects.test.ts`.

**Routes** — all behind `requireAuth`:

| Method | Path | Min role | Notes |
|---|---|---|---|
| `POST` | `/api/projects` | — | Creates project **+ OWNER membership in one transaction** |
| `GET` | `/api/projects` | — | Only projects you are a member of; includes your role |
| `GET` | `/api/projects/:id` | VIEWER | With member list |
| `PATCH` | `/api/projects/:id` | OWNER | Rename |
| `DELETE` | `/api/projects/:id` | OWNER | Cascades members + files |
| `POST` | `/api/projects/:id/members` | OWNER | `{ email, role }` — invite by email |
| `PATCH` | `/api/projects/:id/members/:userId` | OWNER | Change role |
| `DELETE` | `/api/projects/:id/members/:userId` | OWNER | Remove |

**Key implementation decisions**

- **Create is a transaction.** A project without its OWNER membership row is a project
  nobody can open — including its creator. This is the one place that invariant can break.
- **The last OWNER cannot be demoted or removed**, and an OWNER cannot delete their own
  membership. Enforced in the service, returning `409 LAST_OWNER`. Cheaper than an orphaned project.
- **Invite by email, not user id.** User ids are never exposed for lookup; an unknown
  email is `404 USER_NOT_FOUND` (the inviter already knows the address, so this leaks nothing new).
- `service.ts` holds the rules and knows nothing about HTTP; `routes.ts` does zod-parse →
  authorize → call service → shape response. Keeps every file well under the 300-line rule.
- Membership changes take effect on the next request. **Live sessions are not kicked** —
  revocation mid-session lands in Phase 3 with the WS layer. Recorded as a known limitation.

**Done when:** create → the creator is OWNER and the project appears in their list ·
a non-member's `GET /api/projects/:id` → 404 · an EDITOR's `PATCH` → 403 · `DELETE` removes
members and files (verified by row counts) · demoting the last OWNER → 409 · invite by email
→ the invitee now sees the project · all covered by tests.

**Suggested commit:** `feat(projects): add project crud and member management`

---

### Module 1.5 — Files API

**Depends on:** 1.4.

**Files:** `apps/server/src/modules/files/` — `paths.ts`, `service.ts`, `routes.ts`,
`schemas.ts`, `index.ts` · `test/files.test.ts`, `test/paths.test.ts`.

**Routes** — all under `/api/projects/:projectId/files`:

| Method | Path | Min role | Notes |
|---|---|---|---|
| `GET` | `/` | VIEWER | Full tree, nested |
| `GET` | `/:fileId` | VIEWER | Content of one file |
| `POST` | `/` | EDITOR | `{ path, isDir }` — creates parents implicitly |
| `PUT` | `/:fileId` | EDITOR | `{ content }` — **temporary, replaced by Yjs in 3.5** |
| `PATCH` | `/:fileId` | EDITOR | `{ path }` — move/rename |
| `DELETE` | `/:fileId` | EDITOR | Recursive for directories |

**Key implementation decisions**

- **`paths.ts` is pure and separately tested.** Normalization and validation are where
  the security bugs are, and a pure function is far easier to test exhaustively than a route.
  Rules: no leading `/`, no `.` or `..` segment, no `\`, no empty segment, no NUL or control
  characters, segment ≤ 255 chars, path ≤ 1024, depth ≤ 32. **Rejected, never silently sanitized** —
  quietly rewriting a path makes the client and server disagree about what exists.
- **Flat rows, tree assembled in memory.** One indexed query per project, `O(n)` assembly.
  For project-sized trees this beats recursive CTEs, and it keeps `@@unique([projectId, path])`
  as the single collision guard.
- **Rename of a directory is a prefix update inside a transaction** — the directory row plus
  every descendant matching `path LIKE 'old/%'`. The prefix match uses the trailing slash so
  `src2/` is never caught by a rename of `src/`. Delete follows the same shape.
- **Collision is a 409**, never an overwrite. Also blocked: moving a directory inside itself
  (`src` → `src/nested`), which would orphan the subtree.
- **Implicit parent creation:** `POST` with `a/b/c.py` creates the missing `a` and `a/b`
  directory rows in the same transaction. The alternative — forcing the UI to walk the
  path — makes module 2.3 much worse for no benefit.
- **`PUT` content is scaffolding and is labeled as such in the code.** It exists so
  Phase 2's editor is testable before collab lands, and 3.5 takes over writes
  (`docs/PLAN.md:206`). The route survives for non-collab writes; the *editor* stops using it.

**Done when:** a nested tree returns correctly nested from a flat table · duplicate path → 409 ·
`../../etc/passwd`, `/abs`, `a//b`, `a/./b` and a NUL byte are **all rejected 400** (table-driven
test) · renaming `src/` moves every descendant and leaves `src2/` untouched · deleting a
directory removes all descendants and nothing else · moving a directory into itself → 409 ·
a VIEWER gets 403 on `POST`/`PUT`/`PATCH`/`DELETE` but 200 on `GET`.

**Suggested commit:** `feat(files): add project file tree with path validation and recursive ops`

---

## Technologies involved

TypeScript 7 (ESM) · Express 5 · Prisma 7 + `@prisma/adapter-pg` · PostgreSQL 16 ·
`node:crypto` scrypt · `jose` (JWT) · `zod` · `cookie-parser` · Vitest + supertest.

**Not yet:** React, Vite, Tailwind, CodeMirror, Yjs, `ws`, BullMQ, Docker sandbox, Redis.
Redis stays idle in Compose until Phase 6.

---

## What will NOT be implemented in Phase 1

No frontend of any kind — Phase 1 is verified with tests and `curl`, not a browser.
No WebSocket server, no Yjs, no realtime anything. No file *upload* (text content only).
No refresh tokens, password reset, email verification, or rate limiting. No pagination.
No `DocUpdate`/`DocSnapshot` **writes** — the tables exist and stay empty until Phase 4.
No admin surface. No production hardening beyond what's listed above.

---

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Prisma 7 driver-adapter wiring differs from every tutorial online** (S2) | **High** | Isolated in 1.1b behind `db.ts`; `/health` proves it end to end before any feature depends on it |
| **Cookie auth silently 401s in Phase 2** because of the `:5173` → `:4000` origin split | **High if forgotten** | Recorded in Decisions, added to `CLAUDE.md` at phase end, and 2.1's first job is the Vite proxy |
| Root-owned files break `npm`/`git` (S7) | **Certain while running from Windows** | `wsl -u root -e chown -R vivek:vivek /home/vivek/dev/collab-editor` after every write batch, before anything runs as `vivek`. Removed entirely if we move into WSL first |
| Test DB contaminating dev data | Medium | Separate `collab_editor_test` database, asserted by name in the harness before any truncate runs |
| Schema regret after data exists | Medium | The whole model lands in one migration (1.1) and is reviewed before code depends on it |
| Path-handling bug in 1.5 | Medium | `paths.ts` is pure and table-tested; traversal cases are explicit test rows |
| Scope creep into Phase 2 UI | Medium | Phase 1 ships zero frontend. If a route needs a UI to verify, it needs a test instead |
| Express 5 behavioral differences (async error propagation, `req.query` immutability) | Low–Medium | Express 5 forwards async errors to the error middleware natively — this is why 1.1b establishes the pattern before routes exist |

---

## Definition of "Phase 1 complete"

All must hold simultaneously:

1. `npm run build` and `npm run typecheck` exit 0.
2. `npx vitest run` — **all tests pass**, covering every "Done when" above.
3. The server boots, `/health` returns `{"ok":true}` against the live Postgres.
4. Two registered users, a project owned by one, the second added as EDITOR, a nested
   file tree created and read back — verified end to end.
5. A non-member is refused on every project and file route.
6. `assertProjectAccess` is callable with no Express request object (3.4's prerequisite).
7. `find ~/dev/collab-editor ! -user vivek` (excluding `node_modules`) returns nothing.
8. `docs/plans/phase-1-plan.md` rewritten to actual-built state, deviations included.
9. `CLAUDE.md` updated: phase status, new deps, the Vite-proxy requirement, known limitations.
10. Six suggested commit messages handed over, **uncommitted**.

---

## End-to-end verification

From a WSL terminal in `~/dev/collab-editor`:

```bash
docker compose -f infra/docker-compose.yml up -d
npm run build && npm run typecheck
npx vitest run --dir apps/server
npm run dev -w @collab/server &

# cookie jar stands in for the browser
curl -sc jar -X POST localhost:4000/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"a@x.com","password":"correct-horse","displayName":"A"}'
curl -sb jar localhost:4000/api/auth/me
PID=$(curl -sb jar -X POST localhost:4000/api/projects \
  -H 'content-type: application/json' -d '{"name":"demo"}' | jq -r .id)
curl -sb jar -X POST "localhost:4000/api/projects/$PID/files" \
  -H 'content-type: application/json' -d '{"path":"src/main.py","isDir":false}'
curl -sb jar "localhost:4000/api/projects/$PID/files"        # nested tree

# must be rejected
curl -sb jar -X POST "localhost:4000/api/projects/$PID/files" \
  -H 'content-type: application/json' -d '{"path":"../../etc/passwd"}'   # 400
curl -s  localhost:4000/api/projects                                      # 401, no cookie
```

---

## Open items — please confirm before we start

1. **Move Claude Code into WSL first?** (S7) The Phase 0 plan said this happens *before*
   Phase 1, and it hasn't. Moving eliminates the root-ownership problem for the rest of
   the project — but it ends this session, and Phase 1 restarts in a fresh one:
   ```bash
   npm install -g @anthropic-ai/claude-code    # inside Ubuntu
   cd ~/dev/collab-editor && claude
   ```
   Staying on Windows is safe (the `chown` rule works) but costs a command per module.

2. **Pacing.** Default is one module per turn, then stop. Say so if you want a
   longer run — e.g. 1.1 + 1.1b together, since 1.1b is what makes 1.1 verifiable.

---

## Handoff at the end of Phase 1 *(planned)*

- Updated `CLAUDE.md` and this file rewritten to actual-built state.
- Phase summary in your format.
- **Six suggested commit messages, uncommitted** — you run every `git commit`.
- A short note on what Phase 2 inherits: the route surface, the cookie contract, and
  the Vite proxy requirement.

---
---

# ACTUAL IMPLEMENTATION — completed 2026-08-09

Everything above is the plan as approved. This section records what was really built,
including where reality diverged.

## Modules completed

| Module | Status | Tests | Notes |
|---|---|---|---|
| 1.1 Data model | ✅ | — | 7 models + `Role` enum, one migration `20260809100854_phase1_models` |
| 1.1b Runtime foundation | ✅ | 6 | Express 5, Prisma driver adapter, Vitest harness |
| 1.2 Auth module | ✅ | 17 | scrypt, `jose` cookie sessions, `requireAuth` |
| 1.3 Authorization | ✅ | 14 | `assertProjectAccess` — transport-agnostic, proven |
| 1.4 Projects API | ✅ | 24 | CRUD + member management |
| 1.5 Files API | ✅ | 67 | 37 pure path tests + 30 integration |

**128 tests, all passing.** `npm run build`, `npm run typecheck` and
`npm run typecheck:test -w @collab/server` all exit 0.

## Verified end to end

Two users, real HTTP, cookie jars:

| Check | Result |
|---|---|
| Register Alice + Bob | 201, 201 |
| Alice creates a project | 201, `role: OWNER` |
| Bob reads it **before** invite | **404 PROJECT_NOT_FOUND** (existence hidden) |
| Alice invites Bob as EDITOR | 201 |
| Bob creates `src/main.py` | 201 — parent `src/` created implicitly |
| Alice reads the tree | 200, correctly nested |
| Bob posts `../../etc/passwd` | **400 INVALID_PATH** |
| No cookie on `/api/projects` | **401 UNAUTHENTICATED** |
| Bob (EDITOR) deletes the project | **403 FORBIDDEN** |
| `SIGINT` | exit 0 |

Ownership scan (`find ! -user vivek`) clean after every module.

## Deviations from the plan

**1. `prisma.config.ts` had to be fixed (not in the plan).** It called
`process.loadEnvFile()` unconditionally, which **overwrites** an already-set
`DATABASE_URL`. The test harness's `migrate deploy` would therefore have silently
migrated the **dev** database. Now guarded by `if (!process.env.DATABASE_URL)` —
explicit environment beats the file, matching `src/config.ts`.

**2. Added `src/http/params.ts`.** Express 5 types `req.params[name]` as
`string | string[] | undefined`; module 1.4's first build failed on six call sites.
Notably **the tests all passed** — vitest transpiles without typechecking, so only
`tsc` caught it. `routeParam()` validates and narrows in one place.

**3. Added `tsconfig.test.json` + `typecheck:test`.** `tsc -b` compiles only `src/`,
so test code would otherwise never be typechecked. Point 2 is why this matters.

**4. Added `tsx`** for `npm run dev -w @collab/server` — watch mode without a build
step. Node's native type stripping would have required `.ts` import specifiers,
which conflicts with the emit build.

**5. Login timing was fixed mid-module.** The first e2e run measured 188 ms
(wrong password) vs 301 ms (unknown email) — the dummy hash was built lazily, so the
first unknown-email request paid to create it. That is exactly the enumeration signal
the dummy verify exists to remove. It is now warmed at startup; measured after:
`0.148/0.148`, `0.155/0.220`, `0.152/0.147`.

**6. Path prefix matching is done in JavaScript, not SQL `LIKE`.** A legitimate path
may contain `%` or `_`, which are LIKE wildcards. The service loads the project's rows
and filters in memory — consistent with "tree assembled in memory" anyway, and it
removes the bug class entirely. `100%.py` is an explicit test case.

**7. `GET` on a directory returns 400 `IS_DIRECTORY`**, symmetric with `PUT`. The plan
did not specify it.

**8. Two membership guards instead of one code.** The plan folded self-removal into
`LAST_OWNER`; implemented as `CANNOT_REMOVE_SELF` (409) and `LAST_OWNER` (409)
separately, because the messages tell the user different things.

**9. Files router mounted before the projects router**, so the more specific
`/api/projects/:projectId/files` path wins before `/:id` is tried.

## Not done (as planned)

No frontend, no WebSocket, no Yjs, no refresh tokens, no rate limiting, no pagination.
`DocUpdate`/`DocSnapshot` exist and stay empty until Phase 4.

## Definition of complete — final state

1. ✅ `build` and `typecheck` exit 0
2. ✅ 128/128 tests pass
3. ✅ Server boots, `/health` hits the live database
4. ✅ Two users, a shared project, a nested tree — verified end to end
5. ✅ Non-member refused on every project and file route
6. ✅ `assertProjectAccess` callable with no Express request — 3.4's prerequisite,
   asserted in a test *and* confirmed in the emitted `dist/` output
7. ✅ No root-owned strays
8. ✅ This file updated to actual-built state
9. ✅ `CLAUDE.md` updated
10. ✅ Six commit messages handed over, uncommitted

**Phase 1 is complete. Nothing has been committed — all commits are the user's to make.**
