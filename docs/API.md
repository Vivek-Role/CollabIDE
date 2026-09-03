# API reference

Three surfaces, and they are genuinely different protocols:

| Surface | Path | Carries |
|---|---|---|
| **REST** | `/api/**` | Auth, projects, members, files, starting runs |
| **WebSocket** | `/ws?doc=<projectId>:<fileId>` | Collaborative document editing and presence |
| **SSE** | `GET /api/projects/:projectId/runs/:jobId/stream` | One run's output |

**Source of truth:** `apps/server/src/app.ts`, the four `routes.ts` files, `http/errors.ts`,
`modules/collab/wsServer.ts` and `packages/shared/src/protocol.ts`. Read on **2026-09-03**.

---

## 1. Conventions

### Authentication

Every authenticated route reads the **`ce_session` cookie** — an HS256 JWT, `httpOnly`,
`SameSite=Strict`, `secure` in production, 7-day expiry. There is **no `Authorization` header
path and no bearer token**, and the WebSocket takes no `?token=` parameter.

`requireAuth` verifies the JWT and then **re-reads the user row**, so a token for a deleted user
fails. Every authentication failure is the same `401 UNAUTHENTICATED` — "no cookie", "expired"
and "tampered" are not distinguished.

### Authorization

Routes that name a project are guarded by `requireProjectRole(minRole)`, which calls
`assertProjectAccess`. Ranking is `VIEWER < EDITOR < OWNER`.

> **404 versus 403, and it is deliberate.** Not a member → **404**, so project existence stays
> private. **403** means "you are a member, but not senior enough" — there the project's
> existence is already known to you. A non-existent project and a project you cannot see return
> the identical response.

The same function guards the WebSocket join, so the two surfaces cannot drift.

### Origin

`originCheck` runs on **mutating methods only** (`POST`, `PUT`, `PATCH`, `DELETE`). A request
whose `Origin` header is present and is not `WEB_ORIGIN` gets `403 BAD_ORIGIN`. **A missing
`Origin` header is allowed through** — curl and server-to-server callers do not send one.

This fails half-visibly: get `WEB_ORIGIN` wrong and reads work while every write 403s.

### Request bodies

JSON, `express.json({ limit: '1mb' })`. Bodies are parsed with zod; a failure is
`400 VALIDATION_ERROR` with a `details` array.

### The error envelope

Every error, from every route, has one shape:

```json
{ "error": { "code": "SOME_CODE", "message": "human readable", "details": [] } }
```

`details` appears only on `VALIDATION_ERROR`. **Stack traces never cross the wire.**

| Cause | Status | `code` |
|---|---|---|
| zod rejected the body | 400 | `VALIDATION_ERROR` + `details: [{path, message}]` |
| Prisma P2002 (unique violation) | 409 | `CONFLICT` |
| Prisma P2025 (record not found) | 404 | `NOT_FOUND` |
| No route matched | 404 | `NOT_FOUND` ("Route not found") |
| Anything unexpected | 500 | `INTERNAL_ERROR` (logged server-side, details withheld) |

**The client branches on `code`, never on `message`.**

---

## 2. Health

### `GET /health`

No authentication. Not under `/api`.

Deliberately executes `SELECT 1` rather than returning a constant — it proves the Prisma driver
adapter is actually wired up.

**200** → `{ "ok": true }`

---

## 3. Authentication

### `POST /api/auth/register`

Public.

```json
{ "email": "demo@example.com", "password": "demo-password", "displayName": "Demo" }
```

`email` is trimmed and lowercased before storage, 3–254 chars, loose pattern check.
`password` is **10–256 characters, with no composition rules**. `displayName` is 1–80 trimmed.

**201** → `{ "user": { "id", "email", "displayName", "createdAt" } }` and `Set-Cookie: ce_session=…`

`passwordHash` is not a field on the serialized user anywhere in the codebase, so it cannot
leak from a future route by accident.

| Error | |
|---|---|
| `400 VALIDATION_ERROR` | Bad email, short password, empty display name |
| `409 EMAIL_TAKEN` | Already registered (the unique index is the real guard; a race surfaces as P2002 → 409) |

### `POST /api/auth/login`

Public.

```json
{ "email": "demo@example.com", "password": "demo-password" }
```

`password` here is validated as non-empty only — an existing password that predates a rule
change must still be able to log in.

**200** → `{ "user": { … } }` and `Set-Cookie`

| Error | |
|---|---|
| `401 INVALID_CREDENTIALS` | **Identical for an unknown email and a wrong password**, and an unknown email burns an equal-cost dummy scrypt so the two cannot be told apart by timing |

### `POST /api/auth/logout`

Public (no auth required). Clears the cookie with the same flags minus `maxAge` — otherwise the
browser treats it as a different cookie and quietly keeps the old one.

**204**, no body.

> This clears the cookie. It does **not** invalidate the token. See [SECURITY.md](SECURITY.md).

### `GET /api/auth/me`

Authenticated.

**200** → `{ "user": { "id", "email", "displayName", "createdAt" } }` · **401 UNAUTHENTICATED**

---

## 4. Projects

All routes authenticated.

### `GET /api/projects`

Lists projects **you are a member of**, driven from the membership table so a project you are
not in cannot appear even by accident. Ordered by `project.updatedAt` descending.

**200** → `{ "projects": [ { "id", "name", "ownerId", "createdAt", "updatedAt", "role" } ] }`

### `POST /api/projects`

Body `{ "name": "My project" }` — trimmed, 1–100 characters.

Writes the project row and its `OWNER` membership in **one transaction**.

**201** → `{ "project": { …, "role": "OWNER" } }` · `400 VALIDATION_ERROR`

### `GET /api/projects/:id` — **VIEWER**

**200** →
```json
{
  "project": { "id", "name", "ownerId", "createdAt", "updatedAt" },
  "members": [ { "userId", "email", "displayName", "role" } ],
  "role": "EDITOR"
}
```
`role` is *your* role, taken from the guard's membership lookup — free, no second query.

`404 PROJECT_NOT_FOUND` if you are not a member.

### `PATCH /api/projects/:id` — **OWNER**

Body `{ "name": "New name" }` → **200** `{ "project": { … } }`

`403 FORBIDDEN` (member, not owner) · `404 PROJECT_NOT_FOUND` (not a member)

### `DELETE /api/projects/:id` — **OWNER**

Cascades to members and files; also closes every WebSocket in the project with **4409** and
deletes each file's document rows.

**204**, no body.

---

## 5. Members

All **OWNER**.

### `POST /api/projects/:id/members`

```json
{ "email": "alex@example.com", "role": "EDITOR" }
```

> **Members are invited by email, never by user id.** Ids are opaque and are never exposed for
> lookup; the inviter already knows the address they typed.

**201** → `{ "member": { "userId", "email", "displayName", "role" } }`

| Error | |
|---|---|
| `404 USER_NOT_FOUND` | No account for that email |
| `409 ALREADY_MEMBER` | |
| `400 VALIDATION_ERROR` | `role` not one of the three |

### `PATCH /api/projects/:id/members/:userId`

Body `{ "role": "VIEWER" }` → **200** `{ "member": { … } }`

Closes that user's sockets in this project with **4409**, in both directions — a *promoted*
VIEWER must also reconnect, because their open socket still carries `canWrite: false`.

`404 MEMBER_NOT_FOUND` · `409 LAST_OWNER` (a project must always have at least one owner)

### `DELETE /api/projects/:id/members/:userId`

**204.** Closes that user's sockets in this project with **4409**.

`404 MEMBER_NOT_FOUND` · `409 CANNOT_REMOVE_SELF` · `409 LAST_OWNER`

---

## 6. Files

Mounted at `/api/projects/:projectId/files`. **Reads need VIEWER, writes need EDITOR** — that
split is the reason the VIEWER role exists, and the WebSocket enforces the same one.

`INVALID_PATH` (400) can come from any route that takes a path. The rules are in
[DATABASE.md](DATABASE.md) §4.

### `GET /api/projects/:projectId/files` — **VIEWER**

**200** → `{ "tree": TreeNode[] }`, where

```ts
TreeNode = {
  id: string; path: string; isDir: boolean;
  createdAt: string; updatedAt: string;
  name: string;            // basename, computed server-side
  children: TreeNode[];
}
```

Sorted **directories first, then alphabetically** — decided once on the server rather than in
every client. `content` is **not** included.

### `GET /api/projects/:projectId/files/:fileId` — **VIEWER**

**200** → `{ "file": { "id", "path", "isDir", "createdAt", "updatedAt", "content" } }`

This is the only route that returns file text, and the text is `File.content` — **derived state
that can lag the live document by up to one flush (~2 s)** and cannot include edits made while a
client's socket was down. Project search reads this route once per file.

`404 FILE_NOT_FOUND` (also when the id belongs to another project) · `400 IS_DIRECTORY`

### `POST /api/projects/:projectId/files` — **EDITOR**

```json
{ "path": "src/main.py", "isDir": false }
```

`isDir` defaults to `false`. Intermediate directories are **not** created implicitly; the
ancestor check runs inside the transaction.

**201** → `{ "file": { "id", "path", "isDir", "createdAt", "updatedAt" } }`

| Error | |
|---|---|
| `400 INVALID_PATH` | |
| `409 PATH_EXISTS` | Something is already at that path |
| `409 PARENT_NOT_DIRECTORY` | An ancestor exists and is a file |

### `PATCH /api/projects/:projectId/files/:fileId` — **EDITOR**

Move or rename. Body `{ "path": "src/renamed.py" }`. For a directory, every descendant's path
is rewritten in the same transaction.

**200** → `{ "file": { …, "path": "<new path>" } }`

`404 FILE_NOT_FOUND` · `409 INVALID_MOVE` (a directory into itself) · `409 PATH_EXISTS` ·
`409 PARENT_NOT_DIRECTORY`

> Known client defect: open tabs for descendants of a renamed folder keep showing the old path
> until reopened.

### `DELETE /api/projects/:projectId/files/:fileId` — **EDITOR**

Recursive for a directory. Closes the affected rooms with **4409** and deletes their document
rows.

**200** → `{ "deleted": 3 }` — a **count**, not a list of ids.

`404 FILE_NOT_FOUND`

### There is no `PUT` for file content

Removed deliberately in module 4.4. Text is written through the collaboration socket, and a
REST write would be silently overwritten by the next flush. `File.content` has exactly one
writer. The client's `api.put` helper has zero call sites.

---

## 7. Code execution

Mounted at `/api/projects/:projectId`. **Both routes require EDITOR**, not VIEWER — running code
consumes host CPU and memory and executes whatever the project contains.

### `POST /api/projects/:projectId/run` — **EDITOR**

```json
{ "entrypoint": "src/main.py" }
```

`entrypoint` is 1–512 characters. **The client never names a language** — the server resolves it
from the file extension, because a client that could pair arbitrary code with an arbitrary
container image would be a hole. Registered today: `.py` → Python, `.js`/`.mjs`/`.cjs` → Node.

Before enqueueing, the server flushes every open room so `File.content` is current, reads the
project's files, and enforces the caps.

**202 Accepted** → `{ "jobId": "<uuid>" }` — accepted, not completed.

| Error | |
|---|---|
| `400 LANGUAGE_UNSUPPORTED` | No runtime for that extension (`.ts` included — the editor highlights it, the slim Node image cannot run it) |
| `404 FILE_NOT_FOUND` | Entrypoint is not in this project |
| `413 RUN_TOO_LARGE` | More than 100 files, or more than 1,000,000 bytes total |
| `429 TOO_MANY_RUNS` | 20 runs already active on this instance |
| `403 FORBIDDEN` / `404 PROJECT_NOT_FOUND` | VIEWER / non-member |

### `GET /api/projects/:projectId/runs/:jobId/stream` — **EDITOR**

`text/event-stream`. Headers: `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`,
`X-Accel-Buffering: no`. Headers are flushed immediately, or a browser waiting on them shows an
empty terminal.

Authorization is checked **three ways**: authenticated, EDITOR *now* (membership may have changed
since the POST), and `entry.projectId === :projectId`. A job from another project is a `404`, the
same code as an unknown job, so the URL space leaks nothing. **A `jobId` is not a capability.**

Each event is `data: <json>\n\n`, where the JSON is one `RunFrame`:

```ts
type RunFrame =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit';
      status: 'ok' | 'timeout' | 'error';
      exitCode: number | null;
      durationMs: number;
      truncated: boolean;
      message?: string }        // 'error' only; never user code or a stack trace
```

Frames buffered since the subscription opened are **replayed in order** on attach, so a program
that finished before the browser connected still delivers its output.

**Exactly one `exit` frame ends every run**, and the server calls `res.end()` on it. The client
then closes the `EventSource` — its automatic reconnect is deliberately suppressed, because a
run is bounded and nothing about it retries.

`404 RUN_NOT_FOUND` — unknown, expired, already drained, or belonging to another project.

> **Runs do not cross server instances.** The registry is in memory, so the browser must reach
> the instance that accepted its POST. With two instances behind no sticky routing this is a
> `404`. Verified in module 7.2 and recorded rather than fixed.

---

## 8. WebSocket

```
ws://<same origin>/ws?doc=<projectId>:<fileId>
```

**Authenticated by the `ce_session` cookie on the upgrade request.** `docs/PLAN.md` row 3.2 says
a query-parameter token; it was deliberately never built — a token in a URL lands in proxy logs
and `Referer` headers.

The handshake checks, in order: `Origin` (present and matching `WEB_ORIGIN`, or absent); the
`doc` parameter's **shape only**; the cookie. Then, before the socket is attached to any room,
`assertProjectAccess(userId, projectId, 'VIEWER')` runs, and the file must exist in that project
and not be a directory.

`WebSocketServer({ noServer: true })` is what makes rejection possible — with `{ server }`, `ws`
would complete the upgrade before this code got a say.

### Frames

**Binary only.** A text frame closes the socket with 4400.

```
┌────────────┬──────────────────────────────┐
│ type (var) │ y-protocols payload          │
└────────────┴──────────────────────────────┘
  0 = Sync        y-protocols/sync
  1 = Awareness   y-protocols/awareness
```

The server sends sync step 1 on join, then the room's current awareness if any. A **VIEWER**'s
socket is admitted read-only: any Sync frame that is **not** sync step 1 is dropped server-side.

### Close codes

Application codes in the private 4000–4999 range — never a pre-upgrade HTTP status, because a
browser cannot read one (`onclose` reports 1006 with no reason).

| Code | Meaning | Client behaviour |
|---|---|---|
| **4400** | Missing or malformed `?doc`, **an `Origin` header that is present and does not match `WEB_ORIGIN`**, a text frame, or an unknown message type | Terminal |
| **4401** | No cookie, or a bad, expired or orphaned token | Terminal |
| **4403** | A member, but not senior enough. **Reserved** — the call site is live but unreachable while VIEWER is the floor | Terminal |
| **4404** | Not your project, or no such file in it | Terminal |
| **4409** | Role changed, membership revoked, or the file/project was deleted while connected | Terminal |

Everything else — 1006, 1001, 1011, a socket that never opens — is **retried** with full-jitter
backoff, `random(0, min(15 s, 500 ms · 2^attempt))`.

---

## 9. What the API does not have

- **No `Authorization` header, no API keys, no OAuth, no refresh tokens.**
- **No pagination anywhere.** `GET /api/projects` and the file tree return everything.
- **No rate limiting on any route**, including login and `/ws`.
- **No search endpoint.** Project search is entirely client-side, reusing
  `GET …/files/:fileId` once per file.
- **No run history, no run cancellation, no stdin, no reattaching to a run after a reload.**
- **No OpenAPI/Swagger document**, and no generated client — `apps/web/src/lib/api.ts` is
  hand-written and is the only place in the client that calls `fetch`.

---

## 10. Verification

Routes, schemas, status codes and error codes in this document were read from source on
**2026-09-03** and cross-checked against the test suite, which passed **245 tests in 13 files**
on that date. The suites that exercise this surface directly are `auth` (17), `projects` (24),
`files` (29), `authorize` (14), `execution` (12) and `collab` (25).

**Not verified here:** no request in this document was replayed by hand against a running
server during this audit, and the SSE stream and WebSocket were not exercised from a browser.
The shapes come from the source and from the tests that assert them.
