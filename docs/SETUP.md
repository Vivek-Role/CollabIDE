# Setup

Everything needed to run this project locally, plus the two-instance stack, the test suite and
the load harness.

**This is a local development setup. There is no deployment configuration in this repository** —
see [SECURITY.md](SECURITY.md) §Deployment.

---

## 1. Prerequisites

| Requirement | Why |
|---|---|
| **WSL2 (Ubuntu)**, with the repo on the **Linux** filesystem (`~/dev/…`, not `/mnt/c`) | Native filesystem speed, a native Docker socket, and LF line endings |
| **Node ≥ 24** | `.nvmrc` pins `24`; `package.json` declares `"node": ">=24"`. The server uses `process.loadEnvFile`, a Node 24 builtin, instead of a `dotenv` dependency |
| **Docker Desktop** with WSL integration enabled | PostgreSQL, Redis and the sandbox images all run as containers |

PostgreSQL, Redis and both language runtimes come from containers. **Nothing else is installed
on the host** — no local Postgres, no Redis, no Python, no `dotenv`.

The stack is TypeScript 7, ESM throughout (`"type": "module"`, `NodeNext`), npm workspaces with
TS project references.

---

## 2. Install and configure

```bash
nvm use            # Node 24
npm install
cp .env.example apps/server/.env
```

### Environment variables

`apps/server/config.ts` parses the environment **once, at import, with zod, and refuses to boot
if it is wrong**. A missing `JWT_SECRET` crashes on startup with a readable message rather than
producing a 500 on the first login three days later.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | **yes** | — | Must match the compose credentials |
| `JWT_SECRET` | **yes** | — | **Minimum 16 characters.** Change it before anything leaves your machine |
| `NODE_ENV` | no | `development` | `production` is what turns on the cookie's `secure` flag |
| `PORT` | no | `4000` | |
| `WEB_ORIGIN` | no | `http://localhost:5173` | The **one** origin allowed to make mutating requests |
| `REDIS_URL` | no | `redis://localhost:6379` | Defaulted, not required — `buildApp()` must keep booting without Redis |
| `DOC_BUS_ENABLED` | no | on outside tests | Gates **only** the two doc-bus call sites in `syncHandler.ts`. Not a feature switch |

The runner reads only `REDIS_URL`, from its own environment or `apps/runner/.env`, defaulting to
`redis://localhost:6379`. On a normal checkout `apps/runner/.env` does not exist and the default
is the live path — which matches the compose file, so **the runner starts on a clean clone with
no configuration at all**.

> **Two traps, both real:**
>
> 1. **An explicitly-set env var always beats `.env`.** `config.ts` loads `apps/server/.env`
>    *only* when `DATABASE_URL` is unset. Exporting `DATABASE_URL` in your shell therefore
>    suppresses the entire file, and the server dies complaining about `JWT_SECRET`. This is the
>    same mechanism that lets the test harness point at `collab_editor_test`.
> 2. **Changing `REDIS_PORT` moves the server and leaves the runner behind.** Export `REDIS_URL`
>    for the runner too.

---

## 3. Infrastructure

```bash
docker compose -f infra/docker-compose.yml up -d
```

Brings up two containers, pinned to a major version, with named volumes (not bind mounts, which
sidesteps the Windows/WSL permission problems entirely):

| Container | Image | Port | Notes |
|---|---|---|---|
| `collab-postgres` | `postgres:16-alpine` | `${POSTGRES_PORT:-5432}` | Healthcheck is `pg_isready`, so "up" means "accepting connections" |
| `collab-redis` | `redis:7-alpine` | `${REDIS_PORT:-6379}` | `--appendonly yes`, so queue state survives a restart |

Check them:

```bash
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
```

Both should report `(healthy)`.

---

## 4. Database

```bash
cd apps/server
npx prisma generate
npx prisma migrate deploy
cd ../..
```

> **`generate` is not optional on a fresh clone.** npm's `allow-scripts` gate leaves Prisma's
> postinstall unapproved, so `@prisma/client` exports nothing and the next step fails with
> ~25 errors of the form *"has no exported member 'PrismaClient'"*. This was found by an actual
> timed run on a fresh clone, not predicted.

`migrate deploy` — never `migrate dev` — applies the two existing migrations without generating
one. Schema details: [DATABASE.md](DATABASE.md).

---

## 5. Build

```bash
npm run build          # tsc -b across shared, server and runner, in dependency order
```

With project references, **building *is* typechecking**. `@collab/shared` must be built because
the server needs it at runtime.

| Script | Does |
|---|---|
| `npm run build` | `tsc -b` — shared, server, runner |
| `npm run build:web` | Vite production build of the client |
| `npm run typecheck` | The same graph, plus the web and loadtest workspaces |
| `npm run clean` | `tsc -b --clean` |

`apps/web` sits **outside** the root `tsc -b` graph — a Vite app wants bundler resolution and
`noEmit`, which fight `composite`. `scripts/` is in no typecheck target at all.

---

## 6. Run it

Three terminals, or two if you do not need the Run button:

```bash
npm run dev:server     # :4000  REST + WebSocket
npm run dev:web        # :5173  the UI
npm run dev:runner     # the sandbox worker — only needed for Run
```

Then seed the demo, **with the server already running** — it talks to the live REST and
WebSocket surfaces exactly as a browser does, including a real Yjs write. There is no database
back door:

```bash
npm run seed:demo
```

Open **<http://localhost:5173>** and log in:

| Email | Password |
|---|---|
| `demo@example.com` | `demo-password` |
| `alex@example.com` | `demo-password` |

> **Always go through `:5173`, never `:4000` directly.** The session cookie is
> `httpOnly; SameSite=Strict`, and Vite proxies `/api` and `/ws` so the browser sees one origin.
> Bypass the proxy and login appears to succeed while every later request 401s. `strictPort` is
> on deliberately: a silent move to `:5174` would quietly change the cookie's origin.

### The Run button needs images

```bash
bash infra/images/build.sh     # collab-sandbox-python:1, collab-sandbox-node:1
```

Without them the runner **fails the run** rather than silently contacting a registry —
`--pull never` is deliberate. Details: [EXECUTION.md](EXECUTION.md) §5.

---

## 7. Two instances

Collaboration is multi-instance. One Redis, one Postgres, two servers:

```bash
npm run dev:server    +  npm run dev:web       # :4000 / :5173
npm run dev:server:b  +  npm run dev:web:b     # :4001 / :5174
npm run dev:runner                             # one runner serves both
```

Three settings must line up, and the scripts set all three:

| | |
|---|---|
| `PORT=4001` | The second server's port |
| `WEB_ORIGIN=http://localhost:5174` | **The one that fails half-visibly.** Get it wrong and reads work while every mutating request 403s `BAD_ORIGIN`, because `originCheck` guards mutating methods only |
| `API_PORT=4001` | Read by `vite.config.ts`. Unset it and the second browser silently proxies to the *first* server and proves nothing |

`API_PORT` is the only thing made configurable in `vite.config.ts`; `port: 5173` and
`strictPort: true` stay, because a loud port collision beats a cookie origin that quietly moved.

**Run output does not cross instances** — a browser must reach the instance that accepted its
POST. See [EXECUTION.md](EXECUTION.md) §12.

---

## 8. Tests

```bash
npm test
```

**245 tests in 13 files**, run against a real database — no mocks, no in-memory substitute.

The harness creates and migrates **`collab_editor_test`** automatically on the same Postgres
container: `globalSetup.ts` derives the URL from your `DATABASE_URL` by appending `_test`,
creates the database if it is missing, and runs `prisma migrate deploy` against it. It
**refuses to run** if the resulting name does not end in `_test`, and every destructive helper
re-checks that suffix — a misconfiguration cannot quietly wipe your development data.

Vitest injects `NODE_ENV=test`, the test `DATABASE_URL` and a fixed `JWT_SECRET`, so the suite
never depends on your real secret. Files run **serially** (`fileParallelism: false`) because
they share one database and truncate between cases.

**Redis is not required** for the suite, with one exception: `execution.test.ts ›
"allows an EDITOR"` reaches BullMQ's lazy `queue.add` and hangs when Redis is down.

There are **no frontend tests and no runner tests** — see [SECURITY.md](SECURITY.md) §Testing.

---

## 9. Load harness

```bash
npm run loadtest -- --help
```

Headless Yjs clients in `worker_threads`. Two rules from experience:

- **Pass `--database-url`; never export `DATABASE_URL` first** — it suppresses the server's
  `.env` load (§2) and aborted a real run.
- **Measure against the built server** (`node apps/server/dist/index.js`), never `tsx watch` —
  that is a three-process tree with a watcher and an ambiguous pid.
- A two-instance *distributed* scenario needs `--docs` **coprime** with the server count, or
  every client of a document lands on one instance and the doc bus carries nothing.

Method, environment and results: `docs/notes/loadtest-results.md`, with 19 raw blobs in
`loadtest/results/`.

---

## 10. Troubleshooting

| Symptom | Cause |
|---|---|
| Login succeeds, then everything 401s | You bypassed the Vite proxy. Use `:5173`. Do not add `changeOrigin: true` to the proxy |
| Reads work, writes fail `403 BAD_ORIGIN` | `WEB_ORIGIN` does not match the browser's origin. The second instance needs `http://localhost:5174` |
| Server exits complaining about `JWT_SECRET` | You exported `DATABASE_URL` in that shell, which suppressed the whole `.env`. Unset it |
| `tsc -b` fails with "no exported member 'PrismaClient'" | `npx prisma generate` was not run (§4) |
| Vite refuses to start on a busy `:5173` | `strictPort` is on deliberately |
| **Run** does nothing, terminal waits forever | `dev:runner` is not running, or the sandbox images were never built. The stream is never closed in this case — a known gap |
| `npm install` warns about ignored build scripts | Prisma's and esbuild's install scripts are unapproved by npm's `allow-scripts` gate. Harmless here |
| A code change does not seem to take effect in `npm start` | `dist/` can be older than `src/`. `tsc -b` is incremental and content-hash based, so a plain rebuild may report nothing to do. Force it: `npx tsc -b --force`. Note that `dist/` also retains output for **deleted** sources until `npx tsc -b --clean` is run — `apps/server/dist/modules/persistence/__scratch.js` is one such orphan today |
| Files owned by `root` after editing from Windows | Files written over `\\wsl.localhost` are created as root. Run `wsl -u root -e chown -R $USER:$USER ~/dev/collab-editor` |

---

## 11. How long this takes

**17 seconds** for steps 2–6, measured end to end on a fresh clone on **2026-08-15** — splits:
`npm install` 8 s, `prisma generate` + `migrate deploy` 2 s, `npm run build` 2 s, server start +
`seed:demo` 5 s. The stop condition was machine-checked: the demo user logs in over the API and
the seeded project comes back.

**What that number does not include.** It was measured with a **warm npm cache**, with
`postgres:16-alpine` and `redis:7-alpine` **already pulled**, and with the compose stack already
running, so step 3 was a no-op. A genuinely first-ever run pays the npm download and roughly
150 MB of image pulls on top, which is network-bound. **Building the sandbox images is extra and
is not in the 17 seconds.**

**This figure was not re-measured for this document.** What *was* re-verified on **2026-09-03**:
the two containers report healthy, `npm test` passes 245/245 in 46.80 s, and `npm run build:web`
succeeds in 1.04 s producing a 315.56 kB initial bundle.
