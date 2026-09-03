# JavaScript sandbox image — module 6.2.
#
# One of the two images user code runs inside. It installs nothing: a user's
# program gets Node's standard library and no npm packages.
#
# The image is only half of the sandbox. Network isolation, memory/CPU/pid
# limits, capability dropping and the read-only rootfs are runtime flags the
# runner passes (modules 6.3/6.4), not properties of this file.
#
# This is a reasonable local sandbox, NOT production-grade isolation: the kernel
# is shared with the host, no custom seccomp profile is added, and there is no
# user-namespace remapping or gVisor.
#
# Pinned to a major tag on purpose — never :latest. Node 24 matches .nvmrc, so
# sandboxed code and the server share a major version.
FROM node:24-slim

# This base ALREADY ships a `node` user at uid 1000 / gid 1000, so creating one
# would fail with "UID already in use". Reuse it: --user 1000:1000 is numeric
# and never looks at the account name. Only /work has to be made and owned.
RUN mkdir -p /work && chown 1000:1000 /work

# The job's files are copied here before the container starts (ADR-005:
# docker create -> docker cp -> docker start -a, never a bind mount).
WORKDIR /work

# HOME must point somewhere writable: at runtime the rootfs is read-only, and
# this user's home (/home/node) is part of it. /tmp is the tmpfs the runner
# mounts.
ENV HOME=/tmp

# The official image sets ENTRYPOINT ["docker-entrypoint.sh"], a wrapper for the
# published image's own conventions. Clear it so `docker start -a` runs exactly
# the argv the runner passed, with nothing in between.
ENTRYPOINT []

# No CMD: the runner always supplies an explicit argv from LANGUAGES[id].cmd
# plus the entrypoint path.

USER 1000:1000
