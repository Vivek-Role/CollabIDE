# Phase 0 — Summary

**Phase:** 0 — Environment & Skeleton
**Status:** ✅ Complete — 2026-08-09
**Committed:** No. Nothing was committed; all commits are the user's to make.

---

## Modules completed

| # | Module | Result |
|---|---|---|
| 0.1 | WSL2 + Docker Desktop | Ubuntu 26.04 LTS · Docker Desktop 4.85.0 · engine 29.6.2 · Compose v5.3.1 |
| 0.1b | Migration & environment finalization *(added after the audit)* | Repo at `~/dev/collab-editor`, `vivek:vivek`, git identity set, on `main` |
| 0.2 | Monorepo skeleton | 4 npm workspaces, `tsc -b` clean |
| 0.3 | Infra compose | Postgres 16 + Redis 7, both healthy, data persists |
| 0.4 | Prisma bootstrap | Baseline migration applied, client generated, Studio serves |

---

## What was built

A correctly-owned monorepo at `~/dev/collab-editor` on the WSL2 ext4 filesystem, containing:

```
apps/web/        React client                                  (stub)
apps/server/     REST + WebSocket + collab hub — never touches Docker
apps/runner/     BullMQ worker -> Docker sandbox — never touches HTTP/WS
packages/shared/ types shared by all three; imports from no app
infra/           docker-compose.yml (postgres, redis)
docs/            PLAN.md, plans/
```

Plus root config: `package.json` (workspaces), `tsconfig.base.json` + solution `tsconfig.json`, `.gitignore`, `.gitattributes` (LF), `.editorconfig`, `.nvmrc`, `README.md`, `CLAUDE.md`.

Everything is a stub — **no feature code exists yet.** That was the point: Phase 0 proves the environment, nothing more.

---

## Technologies

TypeScript 7 (ESM, `NodeNext`) · npm workspaces + TS project references · Docker Compose · PostgreSQL 16 · Redis 7 · Prisma 7 · Node 24.19.0 via nvm.

Not yet present: React, Vite, Yjs, CodeMirror, Express, BullMQ, sandbox images.

---

## Verified checks

| Check | Result |
|---|---|
| `find . ! -user vivek` (excl. `node_modules`) | no output — no root-owned strays |
| `npm install` | clean, 0 vulnerabilities |
| `npm run build` / `npm run typecheck` | exit **0** |
| `docker compose ps` | `collab-postgres` healthy · `collab-redis` healthy |
| `redis-cli ping` | `PONG` |
| `psql -Atc 'select 1'` | `1` |
| `compose down` → `up -d` → `migrate status` | *"Database schema is up to date!"* — volume persistence proven |
| `prisma studio` | `HTTP/1.1 200 OK` on :5555 |
| `git check-ignore apps/server/.env` | ignored |

---

## Key decisions

| Decision | Why |
|---|---|
| Repo on WSL ext4, not `C:\` or `/mnt/c` | Native FS speed, native Docker socket, LF endings, matches a future Linux VPS |
| ESM + `NodeNext` everywhere | Avoids a painful CJS→ESM migration mid-project |
| TS project references (`tsc -b`) over `--workspaces` | Resolves inter-workspace build order automatically; no ordering hazard |
| Named volumes, not bind mounts | Sidesteps the Windows/WSL permission problem class entirely |
| Images pinned to a major version | A rebuild in six months produces the same stack |
| Prisma confined to `apps/server` | The runner reads plain text, never the DB |
| Node 24 LTS instead of the planned Node 20 | Node 20 reached end-of-life April 2026 |

---

## Deviations from the plan

1. **TypeScript resolved to 7.0.2**, a major version newer than assumed. `tsc -b` worked unchanged.
2. **Prisma 7 removed `url` from the `datasource` block** (`P1012`) → added `apps/server/prisma.config.ts`. Prisma 7 also stopped auto-loading `.env`, so the config uses Node 24's built-in `process.loadEnvFile()` instead of adding a `dotenv` dependency.
3. **Root `build`/`typecheck` use `tsc -b`**, not `npm run … --workspaces` as planned.
4. **Baseline migration needed `--create-only`** — with no models, plain `migrate dev` reports "already in sync" and creates nothing.
5. **npm's `allow-scripts` gate blocked Prisma's postinstall** — harmless; generate/migrate/studio all work.
6. **Claude Code stayed on Windows** for this phase, with `wsl -u root chown -R vivek:vivek` after every write batch. Final ownership scan is clean.

---

## Known limitations

- All four workspaces are stubs; no runtime code.
- `schema.prisma` has **no models**; the baseline migration is empty. Models land in module 1.1.
- **Prisma 7 runtime is not wired up** — `PrismaClient` now requires a driver adapter (`@prisma/adapter-pg` + `pg`), not yet installed.
- `apps/web` still uses `NodeNext` resolution; module 2.1 switches it to bundler resolution with Vite.

---

## Carry-overs into Phase 1

1. Move Claude Code into WSL (`npm i -g @anthropic-ai/claude-code`, then `cd ~/dev/collab-editor && claude`), which ends the `chown` routine.
2. Delete the old `~/code editor` folder — only after the relaunch, since it is the previous session's working directory.
3. Install `@prisma/adapter-pg` + `pg` in module 1.2.

---

## Next phase

**Phase 1 — Auth, projects, files** (modules 1.1–1.5). Requires a written, approved `docs/plans/phase-1-plan.md` before any code is written.
