# Python sandbox image — module 6.2.
#
# One of the two images user code runs inside. It installs nothing: a user's
# program gets the Python standard library and no third-party packages.
#
# The image is only half of the sandbox. Network isolation, memory/CPU/pid
# limits, capability dropping and the read-only rootfs are runtime flags the
# runner passes (modules 6.3/6.4), not properties of this file.
#
# This is a reasonable local sandbox, NOT production-grade isolation: the kernel
# is shared with the host, no custom seccomp profile is added, and there is no
# user-namespace remapping or gVisor.
#
# Pinned to a major+minor tag on purpose — never :latest.
FROM python:3.13-slim

# A non-root user at a fixed uid. The runner starts containers with
# --user 1000:1000, which is numeric, so the id is what matters, not the name.
# This base ships no uid/gid 1000, so both are created here.
RUN groupadd --gid 1000 runner \
 && useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin runner \
 && mkdir -p /work \
 && chown 1000:1000 /work

# The job's files are copied here before the container starts (ADR-005:
# docker create -> docker cp -> docker start -a, never a bind mount).
WORKDIR /work

# HOME must point somewhere writable: at runtime the rootfs is read-only and
# this user has no home directory. /tmp is the tmpfs the runner mounts.
ENV HOME=/tmp

# /work is read-only at runtime, so Python would otherwise attempt a
# __pycache__ write beside every imported local module on every run. It
# tolerates the failure, but not attempting it is cleaner.
ENV PYTHONDONTWRITEBYTECODE=1

# No PYTHONUNBUFFERED: the language registry already carries `python -u`, and
# setting the same thing in two places is how the two eventually disagree.

# No CMD or ENTRYPOINT: the runner always supplies an explicit argv from
# LANGUAGES[id].cmd plus the entrypoint path, so a default would only mislead.

USER 1000:1000
