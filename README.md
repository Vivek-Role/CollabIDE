# collab-editor

A real-time collaborative code editor — multiple authenticated users edit a shared
project simultaneously with live cursors, edits survive refresh and reconnection,
and a **Run** button executes the code inside a resource-limited, network-isolated
Docker container with output streamed to a browser terminal.

> Status: **Phase 0 — environment & skeleton.** No features yet.
> Full build plan in [`docs/PLAN.md`](docs/PLAN.md); per-phase plans in [`docs/plans/`](docs/plans/).

## Requirements

- WSL2 (Ubuntu) — the repo must live on the Linux filesystem, not on `/mnt/c`
- Node **>= 24** (`.nvmrc` pins 24)
- Docker Desktop with WSL integration enabled

## Quickstart

```bash
nvm use
npm install
npm run build

docker compose -f infra/docker-compose.yml up -d
```

## Layout

```
apps/
  web/        React client
  server/     REST + WebSocket + collab hub   (never touches Docker)
  runner/     BullMQ worker -> Docker sandbox (never touches HTTP/WS)
packages/
  shared/     types shared by all three
infra/        docker-compose + sandbox images
docs/         plan, architecture, ADRs, notes
```

`server` and `runner` never import from each other — they communicate only
through the queue and Redis channels, using payload types from `@collab/shared`.

## Scripts

| Command | Does |
|---|---|
| `npm run build` | `tsc -b` across all workspaces in dependency order |
| `npm run typecheck` | same graph, type errors only |
| `npm run clean` | remove build output |
