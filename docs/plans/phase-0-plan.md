# Phase 0 Plan — Environment & Skeleton

> On approval, this file is copied into the repo as `docs/plans/phase-0-plan.md` and becomes the living record for Phase 0.

---

## Context

We are building a real-time collaborative code editor (VS Code + Google Docs + online code runner). Phase 0 exists to get a working, correctly-owned monorepo with running infrastructure **before** any feature code is written, so that later phases never stop to fix environment problems.

Module 0.1 (WSL2 + Docker) is **complete and verified**. This plan covers the rest of Phase 0 — plus a new module 0.1b that exists only because the environment audit turned up two blocking defects.

**Why this phase exists:** every later phase assumes a clean workspace layout, a reachable Postgres/Redis, and a Prisma client that generates. Phase 0 buys that once.

---

## Critical findings from the audit

These drive the plan and are the reason 0.1b was added.

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| **F1** | Everything in `~/code editor` is owned by `root:root` — `.claude/`, `.git/`, `PROJECT-PLAN.md` | `drwxr-xr-x 4 root root … code editor` | git refuses the repo (*"dubious ownership"*); `npm install` as `vivek` would fail |
| **F2** | Files written from Windows over `\\wsl.localhost` are created as **root** | All Windows-created files above are root; `/home/vivek` itself is `vivek:vivek` | **If Claude Code keeps running from Windows, every file it writes is root-owned.** Moving the folder alone does not fix this |
| **F3** | No `~/.gitconfig` exists in WSL at all | `fatal: unable to read config file` | No commit can be authored until identity is set |
| **F4** | `vivek` is uid 1000 **and already in the `docker` group** | `groups=…,1001(docker)` | ✅ Docker needs no `sudo` — nothing to do |
| **F5** | `bash -lc` does not load nvm (Ubuntu `.bashrc` returns early when non-interactive) | node not found in `-lc` shells | Non-interactive calls must `source ~/.nvm/nvm.sh`; `.nvmrc` + interactive shells are fine |
| **F6** | `wsl.exe` output through PowerShell truncates past the first line; the space in `code editor` breaks quoting across PowerShell→wsl→bash | Repeated failures this session | Read command output via a redirect to a temp file; avoid spaces/parens in inlined bash |
| **F7** | **`wsl -u root` works with no password** | `wsl -u root -e bash -c 'id'` → `uid=0(root)` | **Defuses F1 and F2.** Ownership can be corrected on demand (`chown -R`) and the root-owned old folder removed — no `sudo` password, no relaunch required |
| **F8** | Ports **5432 and 6379 are free** on both Windows and WSL | `ss -tulpn` → 0 matches; `Get-NetTCPConnection` → none | 0.3 can use the standard ports unchanged |

**F2 is the important one, and F7 is what makes it survivable.** Left unmanaged, F2 silently poisons every file created for the rest of the project; F7 gives a reliable one-command correction after each write batch.

---

## Decisions locked in

| Decision | Choice | Rationale |
|---|---|---|
| Repo location | `~/dev/collab-editor` (ext4, native, no spaces) | Native FS speed, native Docker socket, LF endings, matches a future Linux VPS |
| Old folder | Deleted after relaunch | Its `.git` has zero commits — nothing to preserve |
| Git identity | `vivek` / `vivekrole6110@gmail.com` | Your choice |
| Node | **v24.19.0** (Active LTS), pinned via `.nvmrc` | Plan said Node 20, but Node 20 hit end-of-life April 2026 |
| **Where Claude Code runs** | **This session, from Windows** — with `wsl -u root chown` after every write batch. Move into WSL **before Phase 1**, not during Phase 0 | Your call: Phase 0 must complete today, and a relaunch would end the session mid-phase. F7 makes this safe |
| Old `~/code editor` folder | **Kept until you relaunch**, deleted after | It is this session's working directory — deleting it now would break the session |
| Module commits | **You commit. I never run `git commit`.** | Per your workflow — supersedes the original plan's "Claude runs git" |
| **Execution mode for Phase 0** | Run **0.1b → 0.2 → 0.3 → 0.4 continuously**, stop at end of phase | Your explicit instruction for this phase, overriding the default stop-after-every-module rule. Resumes from Phase 1 |

---

## Model + effort recommendation

**Recommendation for all of Phase 0: Sonnet 5 at medium effort.**

Phase 0 is scaffolding — config files, a compose file, a Prisma bootstrap. The work is deterministic and well-trodden; correctness comes from care with many small files, not from deep reasoning. Opus 5 would not produce a better `tsconfig.base.json`, and this instruction was explicit: don't spend the expensive option on simple tasks.

| Module | Model | Effort | Why |
|---|---|---|---|
| 0.1b Migration | Sonnet 5 | **Low** | Mechanical shell work, fully specified below |
| 0.2 Skeleton | Sonnet 5 | **Medium** | Many interlocking config files; a wrong `moduleResolution` costs an hour later |
| 0.3 Compose | Sonnet 5 | **Low–Medium** | One YAML file + healthchecks |
| 0.4 Prisma | Sonnet 5 | **Medium** | Generator/client wiring is where Prisma bites |

**Save Opus 5 + high effort for Phase 3 (Yjs sync/awareness), Phase 4 (persistence + compaction), and Phase 6 (sandbox isolation).** That is where genuine distributed-systems reasoning lives.

---

## Modules

### Module 0.1b — Migration & environment finalization *(new)*

**Why:** fixes F1 and F3, and establishes the ownership discipline that neutralises F2 for the rest of Phase 0.

**Steps**

1. **Create the repo tree as `vivek`, from inside WSL** — created natively so it is correctly owned from birth:
   ```bash
   mkdir -p ~/dev/collab-editor/docs/plans
   ```
2. **Set git identity** (fixes F3):
   ```bash
   git config --global user.name  "vivek"
   git config --global user.email "vivekrole6110@gmail.com"
   git config --global init.defaultBranch main
   git config --global core.autocrlf false
   ```
3. **`git init`** in `~/dev/collab-editor`, run as `vivek` → branch `main`, no dubious-ownership error.
4. **Carry the plan across** — `PROJECT-PLAN.md` → `docs/PLAN.md`, and this plan → `docs/plans/phase-0-plan.md`. Copied with `cp` **inside WSL** so ownership stays `vivek`.

**The ownership rule for every module after this one**

Because I am writing from Windows, files land as `root`. So each module ends with the same two steps, in this order:

```bash
wsl -u root -e chown -R vivek:vivek /home/vivek/dev/collab-editor   # F7, no password
wsl -e bash -lc '...'                                              # only then run as vivek
```

Nothing is ever executed as `vivek` before the `chown`. `npm install` in particular must never run against root-owned files.

**Deferred to before Phase 1 — not part of Phase 0**

```bash
npm install -g @anthropic-ai/claude-code     # inside Ubuntu
cd ~/dev/collab-editor && claude             # relaunch natively
```
Then, and only then, remove the old folder (it is this session's cwd until you relaunch):
```powershell
Remove-Item -Recurse -Force '\\wsl.localhost\Ubuntu\home\vivek\code editor'
```

**Done when:** `~/dev/collab-editor` exists and is `vivek:vivek` throughout · `git -C ~/dev/collab-editor status` runs clean with no ownership error · `git config --global user.name` → `vivek` · `docs/PLAN.md` and `docs/plans/phase-0-plan.md` are present.

---

### Module 0.2 — Monorepo skeleton

**Depends on:** 0.1b.

**Files created**

```
package.json              # root, npm workspaces, scripts
package-lock.json
tsconfig.base.json        # shared compiler options
.gitignore                # node_modules, dist, .env, prisma generated
.gitattributes            # * text=auto eol=lf
.editorconfig
.nvmrc                    # 24
README.md
docs/PLAN.md
docs/plans/phase-0-plan.md
apps/web/package.json         + tsconfig.json + src/index.ts
apps/server/package.json      + tsconfig.json + src/index.ts
apps/runner/package.json      + tsconfig.json + src/index.ts
packages/shared/package.json  + tsconfig.json + src/index.ts
```

Each workspace gets a stub only — no framework code yet. `apps/web` stays a stub until 2.1 installs Vite.

**Key implementation decisions**

- **npm workspaces** (`apps/*`, `packages/*`) — no pnpm/yarn, matching the original plan. npm 11.17 handles this fine.
- **ESM everywhere** — `"type": "module"` + `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`. Vite, `ws`, BullMQ and Prisma are all ESM-clean, and choosing this now avoids a painful CJS→ESM migration mid-project. This is the single most consequential decision in the module.
- **`strict: true`** plus `noUncheckedIndexedAccess` — the WS protocol and job payloads are exactly where loose typing causes real bugs.
- `packages/shared` is consumed as `"@collab/shared": "*"` via workspace resolution, so `apps/server` and `apps/runner` share types without a build step in dev.
- Root scripts: `build`, `typecheck`, `dev`, `clean` — all using `--workspaces --if-present` so they no-op cleanly while workspaces are stubs.
- No linter/formatter yet — deliberately deferred so this module stays reviewable.

**Done when:** `npm install` completes with no errors and creates one root `node_modules` + `package-lock.json` · `npm run build` exits 0 (no-op across stubs) · `npm run typecheck` exits 0 · `git status` shows no `node_modules` or `dist`.

**Suggested commit:** `chore: scaffold npm workspaces monorepo with shared tsconfig`

---

### Module 0.3 — Infra compose

**Depends on:** 0.1b (Docker verified in 0.1).

**Files created:** `infra/docker-compose.yml`, `.env.example`, `apps/server/.env` (gitignored).

**Key implementation decisions**

- `postgres:16-alpine` and `redis:7-alpine`, pinned per the original plan — not `:latest`, so a rebuild months from now behaves identically.
- **Named volumes** (`pgdata`, `redisdata`), not bind mounts — avoids the Windows/WSL permission class of problem entirely.
- **Healthchecks are required**, not optional: `pg_isready -U postgres` and `redis-cli ping`. Module 0.4 and every later phase depend on "up" actually meaning "accepting connections".
- Ports `5432` and `6379` published to localhost. Reachable from both WSL and Windows.
- `.env.example` is committed with placeholder values; the real `.env` is gitignored from birth.

**Done when:** `docker compose -f infra/docker-compose.yml up -d` → `docker compose ps` shows both services **healthy** · `docker exec … psql -U postgres -c 'select 1'` succeeds · `docker exec … redis-cli ping` → `PONG` · `docker compose down && up -d` preserves data.

**Suggested commit:** `chore: add postgres and redis compose stack with healthchecks`

---

### Module 0.4 — Prisma bootstrap

**Depends on:** 0.2 (workspace) and 0.3 (a live database).

**Files created:** `apps/server/prisma/schema.prisma`, `apps/server/.env` (DATABASE_URL), `prisma/migrations/` baseline.

**Key implementation decisions**

- Prisma lives in `apps/server` only. `apps/runner` never imports it — it reads plain text materialized by module 4.4, per the original architecture rule.
- Schema at this stage is **datasource + generator only**. Real models (`User`, `Project`, `File`, …) are module 1.1's job; keeping them out here keeps the two modules independently reviewable.
- `DATABASE_URL` read from `apps/server/.env`, which is gitignored; `.env.example` documents the shape.

**Done when:** `npx prisma migrate dev --name init` applies against the running Postgres · `npx prisma generate` produces a client · `npx prisma studio` opens in the browser · restarting the compose stack keeps the migration applied.

**Suggested commit:** `chore: bootstrap prisma with initial migration`

---

## Technologies involved

TypeScript · npm workspaces · Docker Compose · PostgreSQL 16 · Redis 7 · Prisma · nvm/Node 24. No React, no Yjs, no BullMQ yet.

---

## What will NOT be implemented in Phase 0

No auth, no REST routes, no React/Vite app, no CodeMirror, no Yjs, no WebSocket server, no BullMQ, no sandbox images, and **no database models** beyond the empty baseline. Workspace `src/index.ts` files stay stubs. This is deliberate — Phase 0 proves the environment, nothing more.

---

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Root-owned files reappear** — certain, since I write from Windows | **Certain, by design** | `wsl -u root chown -R vivek:vivek` after *every* write batch, before anything runs as `vivek`. Verified with `ls -la` at each module's end |
| A file gets missed by a `chown` and breaks `npm` later | Low–Medium | Final Phase 0 check greps for any non-`vivek` owner across the whole tree |
| ~~Ports 5432/6379 in use~~ | **Ruled out** | Verified free on both Windows and WSL (F8) |
| ESM/CJS friction from a dependency later | Low–Medium | `NodeNext` handles CJS interop; isolated cases use `createRequire` |
| `npm install` slow or odd across the workspace | Low | Repo is on ext4 now — the main cause is already removed |
| Losing context between sittings | Medium | Phase plan + CLAUDE.md updated at phase end; gotchas F1–F6 recorded |
| Prisma version drift vs. tutorials | Low | Pin the exact Prisma version in `package.json` |

---

## Definition of "Phase 0 complete"

All must hold simultaneously:

1. `~/dev/collab-editor` exists, is `vivek:vivek` throughout, and is a valid git repo on `main`.
2. `find ~/dev/collab-editor ! -user vivek` returns **nothing** (no root-owned strays).
3. `npm install`, `npm run build`, `npm run typecheck` all exit 0.
4. `docker compose up -d` → Postgres and Redis both report **healthy**.
5. `npx prisma studio` opens against the live database.
6. `git status` is clean apart from files you have chosen not to commit yet.
7. `docs/plans/phase-0-plan.md` is updated to reflect what was *actually* built.
8. `CLAUDE.md` exists at the repo root.

**Explicitly *not* required for Phase 0 completion:** Claude Code running inside WSL. That move happens before Phase 1.

---

## Handoff at the end of Phase 0

I stop after 0.4 and give you:

- the phase summary in your requested format,
- `CLAUDE.md` + the updated `docs/plans/phase-0-plan.md`,
- **four suggested commit messages, uncommitted** — you run every `git commit`,
- the two commands to move into WSL before Phase 1.

---

## End-to-end verification

Run from a WSL terminal in `~/dev/collab-editor`:

```bash
# ownership + identity
cd ~/dev/collab-editor
find . -path ./node_modules -prune -o ! -user vivek -print    # must print NOTHING
git status && git config --global user.name

# workspace
node --version && npm install && npm run build && npm run typecheck

# infra
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps        # both healthy

# database
cd apps/server && npx prisma migrate status && npx prisma studio
```

---

## Phase-end deliverables (per your workflow)

On Phase 0 completion, before Phase 1 begins:

- **`CLAUDE.md`** at the repo root — architecture, stack, conventions, structure, completed phases, decisions, known limitations, and what future modules must not break. Concise, not a tutorial.
- **`docs/plans/phase-0-plan.md`** updated to actual-built state, with deviations and completed checks marked.
- **Phase summary** in your requested format.
- **Memory** — I'll save the durable workflow rules (you own all commits; phase plan before coding; model/effort recommendation per phase) and the environment gotchas F2/F5, so they survive into future sessions.

Note: I could not write `CLAUDE.md` or memory files during planning — plan mode restricts me to this file. Both happen once you approve.

---
---

# ACTUAL IMPLEMENTATION — completed 2026-08-09

Everything above is the plan as approved. This section records what was really
built, including the places reality diverged from it.

## Modules completed

| Module | Status | Notes |
|---|---|---|
| 0.1 WSL2 + Docker | ✅ | Ubuntu 26.04 LTS, Docker Desktop 4.85.0, engine 29.6.2, Compose v5.3.1 |
| 0.1b Migration | ✅ | Repo at `~/dev/collab-editor`, `vivek:vivek`, git identity set, on `main` |
| 0.2 Monorepo skeleton | ✅ | 4 workspaces, `tsc -b` clean |
| 0.3 Infra compose | ✅ | Postgres + Redis both healthy, data persists across `down`/`up` |
| 0.4 Prisma bootstrap | ✅ | Baseline migration applied, client generated, Studio serves HTTP 200 |

## Verified checks

| Check | Result |
|---|---|
| `find . ! -user vivek` (excl. node_modules) | **no output** — no root-owned strays |
| `npm install` | clean, 0 vulnerabilities |
| `npm run build` / `npm run typecheck` | exit **0** |
| `docker compose ps` | `collab-postgres` healthy, `collab-redis` healthy |
| `redis-cli ping` | `PONG` |
| `psql -Atc 'select 1'` | `1` |
| `compose down` → `up -d` → `prisma migrate status` | *"Database schema is up to date!"* — volume persistence proven |
| `prisma studio` | `HTTP/1.1 200 OK` on :5555 |
| `git check-ignore apps/server/.env` | ignored by `.gitignore:8` |

## Deviations from the plan

**1. TypeScript 7, not 5.x.** `npm install typescript` resolved to **7.0.2** —
a major version newer than the plan assumed. `tsc -b` behaves as expected; no
config changes were needed.

**2. Prisma 7.9.1 broke the planned schema shape.** Prisma 7 **removed `url` from
the `datasource` block** (`P1012`). Two consequences:

- Added `apps/server/prisma.config.ts` holding the datasource URL for the CLI.
- Prisma 7 also **stopped auto-loading `.env`**, so the config calls Node 24's
  built-in `process.loadEnvFile()` — deliberately avoiding a `dotenv` dependency.
  A missing `.env` is caught and ignored so CI can inject the real environment.
- **Outstanding for module 1.2:** `PrismaClient` now needs a **driver adapter**
  (`@prisma/adapter-pg` + `pg`). Not installed — nothing constructs a client yet.

**3. Root `build`/`typecheck` use `tsc -b`, not `npm run … --workspaces`.**
The plan specified `--workspaces --if-present`. TypeScript **project references**
were used instead because they resolve inter-workspace build order automatically
and let `apps/server` consume `@collab/shared` types with no ordering hazard.
`dev` still uses `--workspaces --if-present`. Consequence: with composite
projects, building *is* typechecking, so both scripts run the same command.

**4. Baseline migration needed `--create-only`.** With no models, plain
`migrate dev` would have reported "already in sync" and created nothing. Running
`migrate dev --create-only --name init` then `migrate dev` produced and applied
an empty baseline (`20260808203715_init`), which is what the plan intended by
"first empty migration".

**5. npm's `allow-scripts` gate blocked Prisma's postinstall.** npm 11 warned that
`@prisma/engines` and `prisma` have unapproved install scripts. **This turned out
to be harmless** — `prisma generate`, `migrate` and `studio` all work. Left
unapproved deliberately; revisit only if an engine-related error appears.

**6. Claude Code was not moved into WSL.** The approved plan deferred this so
Phase 0 could finish in one session. The `wsl -u root chown` rule was applied
after every write batch instead, and the final ownership scan is clean.

## Still outstanding

- Move Claude Code into WSL, then delete the old `~/code editor` folder
  (it is the previous session's working directory).
- Install `@prisma/adapter-pg` + `pg` in module 1.2.
- Switch `apps/web` to bundler module resolution in module 2.1.

## Definition of complete — final state

1. ✅ Repo exists, `vivek:vivek` throughout, valid git repo on `main`
2. ✅ No root-owned strays
3. ✅ `npm install` / `build` / `typecheck` all exit 0
4. ✅ Postgres + Redis healthy
5. ✅ Prisma Studio opens against the live database
6. ✅ `git status` clean apart from the intentionally uncommitted tree
7. ✅ This file updated to actual-built state
8. ✅ `CLAUDE.md` exists at the repo root

**Phase 0 is complete. Nothing has been committed — all commits are the user's to make.**
