# Containers, from the sandbox's point of view

Written at the end of Phase 6. Only what was needed to build and reason about
`runInContainer` — not a container tutorial.

## The three mechanisms

A container is not a thing. It is a normal Linux process with three kernel
features applied to it, and every sandbox flag maps to one of them.

**Namespaces — what the process can see.** Separate views of the PID table, the
mount table, the network stack, hostnames, users. `--network none` gives the
process a network namespace containing only loopback, which is why no outbound
connection is possible: there is no route to anywhere, not a firewall rule that
could be argued with.

**cgroups — what the process can use.** A hierarchy the kernel accounts
resources against. `--memory 256m` sets `memory.max`; exceeding it means the
kernel's OOM killer fires *inside* the cgroup, which is why the host survives a
program asking for a gigabyte. `--cpus 0.5` sets a quota-per-period, so a busy
loop gets half a core rather than starving anything. `--pids-limit 64` is
`pids.max`, and it is what makes a fork bomb fail at ~11 forks instead of
exhausting the process table.

**Capabilities — what the process is allowed to do.** Root's powers, split into
about forty separate bits: bind a low port, load a module, change file
ownership. `--cap-drop ALL` removes every one, so even a process running as uid 0
inside the container can do almost nothing privileged. `--user 1000:1000` means
we are not root anyway, and `--security-opt no-new-privileges` stops a setuid
binary from regaining anything.

## What that does and does not buy

Namespaces virtualise *the view*; cgroups bound *the usage*; capabilities remove
*the powers*. **None of them is a separate kernel.** Every container shares the
host's, and a kernel bug reachable from an unprivileged process is reachable from
inside. That single sentence is the whole reason this project says "a reasonable
local sandbox, not production-grade isolation" and does not claim more. The next
rungs — a custom seccomp profile narrowing the syscall surface, user namespaces
so container-root maps to an unprivileged host uid, or gVisor putting a
user-space kernel in between — are all deliberately not climbed.

## Two things learned the hard way

**A read-only rootfs refuses `docker cp`.** `--read-only` is not purely a runtime
property: Docker rejects a copy into such a container even while it is stopped
(`container rootfs is marked read-only`). And a tmpfs mounted at the destination
is worse than a refusal — the copy *reports success*, then the tmpfs is
materialised at start and shadows it, so the program sees an empty directory. The
combination that works is a **read-only rootfs plus a volume at the writable
path**: volumes are separate mounts, so `--read-only` never applied to them.

**Exit 137 does not mean OOM.** 137 is 128 + 9, i.e. "killed by SIGKILL". The
kernel's OOM killer sends SIGKILL, and so does `docker kill`. They are
indistinguishable from the exit code alone, so the only reliable way to tell a
timeout from an out-of-memory is to record whether *you* were the one who asked.

## Why the runner owns the Docker socket alone

Access to the Docker socket is equivalent to root on the host: anything that can
create a container can mount `/` into it. Keeping that capability in one process
that serves no HTTP, imports no database client, and does nothing but consume a
queue is the single most valuable structural decision in the phase — worth more
than any individual flag above.
