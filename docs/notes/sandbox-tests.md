# Sandbox safety tests

**Run:** 2026-08-14 · **Module:** 6.4 · **Branch:** `feat/code-execution`
**Host:** WSL2 Ubuntu 26.04, Docker engine 29.7.2, overlayfs, cgroup v2
**Images:** `collab-sandbox-python:1` (python:3.13.15-slim),
`collab-sandbox-node:1` (node:24.19.0-slim)

Every result below was **observed**, not predicted. Each test ran through
`runWithLimits` — the real driver with the real flags — from a throwaway script
that was deleted afterwards.

---

## What this is, honestly

**This is a reasonable local sandbox, not production-grade isolation.**

The kernel is shared with the host. Only Docker's default seccomp profile
applies — no custom profile was written. There is no user-namespace remapping,
no rootless Docker, and no gVisor. **A kernel exploit escapes this.** What it
does defend against is ordinary hostile or broken code: infinite loops, fork
bombs, memory exhaustion, network access, and writes to the filesystem.

Nothing in this repository may claim more than that.

---

## The flag set under test

```
docker create --rm --pull never --name ce-run-<id> --label ce.run=<id>
  --network none --memory 256m --memory-swap 256m --cpus 0.5 --pids-limit 64
  --read-only --tmpfs /tmp:rw,size=32m --mount type=volume,dst=/work
  --cap-drop ALL --security-opt no-new-privileges --ulimit fsize=33554432
  --user 1000:1000 -w /work <image> <cmd...> <entrypoint>
```

Plus the module 6.4 policy layer: a **10 s** wall clock and a **1,000,000-byte**
output cap, both aborting through the same `AbortSignal`.

---

## The six required tests (`docs/PLAN.md`)

| # | Test | Expected | Observed | ✓ |
|---|---|---|---|---|
| 1 | `while True: pass` | TIMEOUT, container gone | `status=timeout`, **10222 ms**, `exitCode=null` | ✅ |
| 2 | fork bomb | blocked by `--pids-limit` | `fork blocked after 11 : Resource temporarily unavailable` | ✅ |
| 3 | allocate 1 GB | OOM-killed, **server unaffected** | `exit=137`, `"allocated 1GB"` never printed, host and node process fine | ✅ |
| 4 | socket to the internet | fails (`--network none`) | `network blocked: OSError` connecting to 1.1.1.1:53 | ✅ |
| 5 | write to `/` | read-only filesystem error | `root write refused: Read-only file system` | ✅ |
| 6 | after all of the above | `docker ps -a` clean | containers = `[collab-postgres, collab-redis]`, `ce.run` = 0, dangling volumes = 0 | ✅ |

### Test programs, as run

```python
# 1  while True: pass
# 2  import os
#    n=0
#    try:
#        while True:
#            os.fork(); n+=1
#    except OSError as e:
#        print("fork blocked after", n, ":", e.strerror)
# 3  x = bytearray(1024*1024*1024); print("allocated 1GB")
# 4  socket.create_connection(("1.1.1.1", 53), timeout=3)
# 5  open("/rootwrite", "w")
```

**Note on test 2's output.** The recorded line interleaves —
`fork blocked after fork blocked after fork blocked after11 :  Resource
temporarily unavailable` — because each forked child reaches the `except` and
prints too. That is the authentic capture; the limit held at ~11 forks, well
under the 64-pid ceiling, and the container exited normally.

**Note on test 3.** The allocation is killed by the kernel, so the exit code is
**137** — the same code a deliberate `docker kill` produces. They are told apart
by `RunResult.killed`, not by the code. See below.

---

## Limits added by module 6.4

| Test | Observed | ✓ |
|---|---|---|
| Timeout fires at 10 s | `status=timeout`, elapsed **10317 ms**, `truncated=false` | ✅ |
| A fast program is untouched | `print("hi")` → `status=ok`, exit 0, **541 ms** (the timer is cleared, not awaited) | ✅ |
| Output cap truncates | infinite print loop → `truncated=true`, **exactly 1,000,000 bytes** delivered, returned in **612 ms** | ✅ |
| Just under the cap | 900,000 bytes → `truncated=false`, exit 0 | ✅ |
| **Cap beats a later timeout** | a loop that floods **and** would outlive 10 s → `status=ok`, `truncated=true`, **753 ms** — *not* `timeout` | ✅ |
| Sandbox failure is a status, not a throw | unknown language → `status=error`, `message="unknown language: ruby"` | ✅ |

**Why the fifth row matters.** Both limiters abort the same `AbortController`,
so without a first-writer-wins guard on the reason, a program that trips the cap
at 9.9 s would be relabelled `timeout` when the timer fires 100 ms later. The
guard is what keeps a loud program reported as loud.

### Exit code 137 is ambiguous, and that is handled

Measured side by side in one run:

```
OOM     : status=ok       exit=137   killed=false
TIMEOUT : status=timeout  exit=null  killed=true
```

A kernel OOM kill and our own `docker kill` both produce **137**. `killed` is set
only by the driver, which is the sole party that knows whether it issued the
kill — so no `docker inspect` is needed and `--rm` can stay. **An OOM is reported
as `ok` with exit 137**: the program ran, and was killed for exceeding a limit it
was given, much as a segfaulting program "runs".

---

## Workspace growth — a real, documented limitation

`/work` must be a **volume**: with a read-only rootfs, `docker cp` is refused
outright, and a tmpfs at `/work` is refused the same way (and would shadow the
copy even if it were not). A **tmpfs-backed named volume** is worse still — 6.2
measured `docker cp` reporting *success* while the file was silently absent at
runtime. It must never be used.

`--ulimit fsize=33554432` was added instead:

```
program: write 200 MB to /work/big
result : OSError "File too large"; file stopped at exactly 32 MB
```

**This is a per-file bound and nothing more.** It does **not** bound the total
size of the workspace — a program can write many files, each up to 32 MiB. What
bounds the total is the 10-second timeout: writes stop when the container is
killed. **Workspace growth is therefore bounded by disk throughput × 10 s, not by
a quota, and `/work` must never be described as size-limited.** A hard total cap
needs an XFS project quota or a loopback filesystem — real infrastructure, and
out of scope for Phase 6.

`--storage-opt size=` was also tried: accepted without error, but it bounds the
container's *writable layer*, which is `--read-only` and unused here. It does not
apply to volumes.

---

## The reaper

`reapStaleContainers(maxAgeMs = 60_000)` removes `ce.run`-labelled containers
older than the age limit, and their anonymous `/work` volumes with them.

| Test | Observed | ✓ |
|---|---|---|
| A fresh labelled container survives the 60 s default | `reaped=0`, container still present | ✅ |
| `maxAgeMs: 0` removes it **and its volume** | `reaped=1`, gone, volumes **3 → 2** | ✅ |
| Unlabelled containers are never touched | before and after both `[collab-postgres, collab-redis]` | ✅ |

It exists for a runner killed by `SIGKILL` mid-run, which cannot run its cleanup.
In normal operation it finds nothing: `runInContainer` cleans up on every path,
and across roughly 40 runs during modules 6.3 and 6.4 the dangling-volume count
never left 0.

**`docker container prune` is not used** — it leaves anonymous volumes behind,
turning a container leak into a volume leak. **`docker volume prune` is
forbidden** — our volumes are anonymous and unlabelled, so a prune would be
indiscriminate and could delete an unrelated volume belonging to the user.
Volumes are removed only by `rm -v` on the container that owns them. The
consequence, accepted deliberately: a volume whose container was already removed
is unreachable and is left alone.

---

## Final state after the whole run

```
containers      : collab-postgres, collab-redis   (the compose services only)
ce.run labelled : 0
dangling volumes: 0
/tmp/ce-run-*   : 0
```

**17 of 17 checks passed**, in 38.7 s.

---

## Still not covered

- **No custom seccomp profile, no user namespaces, no gVisor.** Named in
  `docs/PLAN.md` as future 6.3/6.4 work and deliberately not attempted.
- **No hard total quota on `/work`** — see above.
- **No per-user or per-project run quotas.** Worker concurrency 2 (module 6.5)
  is the only backpressure, and the `/ws` rate-limit question (Q4) is still
  unassigned.
- **No metrics.** Run durations, timeout rate and truncation rate are Phase 8's,
  and only measured numbers go in the docs.
