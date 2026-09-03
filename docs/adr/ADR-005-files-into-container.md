# ADR-005 — Files into the container: create → copy → start, on a volume-backed `/work`

**Status:** Accepted, **with one correction found by running** · **Decided:** Phase 6
**Implemented:** module 6.3, corrected by module 6.2's findings
**Code:** `apps/runner/src/sandbox/docker.ts`

---

## Context

The runner has the project as plain text in memory (`File.content`, ADR-002) and needs it
inside a container that is about to execute it. The container must have a read-only root
filesystem, no network, no capabilities, and must run as a non-root user.

## Decision

**`docker create` → `docker cp` → `docker start -a`, with `/work` mounted as an anonymous
volume.** No bind mounts.

```
docker create --rm --pull never --name ce-<runId> --label ce.run=<runId>
  --network none --memory 256m --memory-swap 256m --cpus 0.5 --pids-limit 64
  --read-only --tmpfs /tmp:rw,size=32m
  --mount type=volume,dst=/work            <- the correction; see below
  --ulimit fsize=33554432
  --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 -w /work
docker cp <files> ce-<runId>:/work
docker start -a ce-<runId>
```

## Alternatives rejected

| Option | Why not |
|---|---|
| **Bind-mounting a host directory** | On Windows/WSL2 a bind-mounted Windows path brings `--user` permission mismatches and is slow. Create → copy → start is cross-platform, keeps the rootfs read-only, and behaves identically on a future Linux VPS |
| **Baking files into an image per run** | An image build per execution — far slower than a copy, and it litters the local image store |
| **stdin** | Works for one file. The unit here is a project |

## The correction: `/work` MUST be a volume

The original decision said create → copy → start and stopped there. Module 6.2 found that
the sequence does not work at all without one addition, and that the obvious workaround is
worse than the problem. **Three distinct outcomes, and they are routinely confused:**

| `/work` backed by | What actually happens |
|---|---|
| **nothing** — just the `--read-only` rootfs | **`docker cp` is refused outright**: *"container rootfs is marked read-only"* |
| **`--tmpfs /work`** (the flag) | **`docker cp` is refused the same way** — and the tmpfs would shadow the copied files even if it were not |
| **a tmpfs-backed *named volume*** (`--opt type=tmpfs`) | **Worse: the copy reports success and the data is silently gone at start.** The tmpfs is materialised when the container starts and shadows what was copied, so the program sees an empty directory |
| **an anonymous volume** ✅ | Writable, accepts the copy, inherits `/work`'s `1000:1000` ownership from the image, and is removed with the container by `--rm` |

The failure that *reports success and loses the data* belongs to the **tmpfs-backed named
volume**, not to `--tmpfs`. Both must be avoided, but for different reasons, and a
document that merges them will send the next person to the wrong workaround.

Evidence: `apps/runner/src/sandbox/docker.ts:96-105` ·
`docs/notes/sandbox-tests.md:118` · `docs/notes/sandbox.md:49` ·
`docs/plans/module-6.4-plan.md:230-231` · `docs/plans/summary6.md:157-163`.

**Never reintroduce `--tmpfs /work`. Never use a tmpfs-backed volume for `/work`.**

## Consequences

- **`/work` is therefore writable, and has NO total size cap.** `--ulimit fsize=33554432`
  bounds **any single file** to 32 MiB — measured: a 200 MB write is truncated there — but
  a program can write many files. The total is bounded only by the 10-second timeout and
  disk throughput. **`/work` must never be described as size-limited.** A hard cap needs an
  XFS project quota or a loopback filesystem, and neither is built.
- **Volumes go only with their container**, via `--rm` and the reaper's `docker rm -fv`.
  A global `docker volume prune` would delete unrelated user volumes and is forbidden.
  Orphaned volumes are therefore unreachable rather than reaped — measured at 0 dangling
  across ~40 runs.
- **`--pull never`** means a missing image fails instantly and locally, pointing at
  `infra/images/build.sh`, instead of silently contacting a registry.
- **The rest of the rootfs stays read-only**, with a bounded 32 MiB `/tmp` that also serves
  as the image's `HOME`.

## Residual risk — stated plainly

**This is a reasonable local sandbox, not production-grade isolation.** Shared kernel,
Docker's default seccomp profile only, no user-namespace remapping, no gVisor. A kernel
exploit escapes it. That sentence belongs anywhere this sandbox is described, including
verbally.

What it *does* stop was tested rather than assumed — the six safety results are in
`docs/notes/sandbox-tests.md`: infinite loop → TIMEOUT with the container gone; fork bomb →
blocked by `--pids-limit`; 1 GB allocation → OOM-killed with the server unaffected; network
access → refused by `--network none`; writing to `/` → read-only filesystem error; and
`docker ps -a` clean afterwards.

## See also

- ADR-004 — the process that owns the Docker socket and calls this
- `docs/ARCHITECTURE.md` §§5, 10 — the run path and the honest limitations
- `docs/notes/sandbox.md` — how the mechanisms actually work
