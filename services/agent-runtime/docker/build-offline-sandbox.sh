#!/usr/bin/env bash
# Build a sandbox image WITHOUT pulling from a registry.
#
# Use this only in restricted environments where Docker Hub is unreachable (so
# `docker build -f docker/sandbox.Dockerfile` cannot pull python:3.11-slim). It
# imports the host's own toolchain (which must include git + python3 + pytest)
# into an image tagged `devroom-sandbox:local`.
#
# The resulting image is still run with full isolation (--network=none,
# --cap-drop=ALL, --read-only, non-root, resource limits) by the runtime.
set -euo pipefail

IMAGE_TAG="${1:-devroom-sandbox:local}"

command -v docker >/dev/null || { echo "docker is required"; exit 1; }
command -v git >/dev/null || { echo "git must be installed on the host"; exit 1; }
python3 -m pytest --version >/dev/null 2>&1 || {
  echo "pytest must be importable by the host python3 (pip install pytest)"; exit 1;
}

echo "Importing host rootfs into ${IMAGE_TAG} (this can take a minute)…"
# NOTE: the members below are relative (`var`, not `./var`), so exclude patterns
# must be relative too. Excluding `./var/lib/docker` would NOT match and would
# recursively sweep Docker's own image store into the image, ballooning it and
# filling the disk.
tar -C / -c \
  --exclude=proc --exclude=sys --exclude=dev --exclude=run \
  --exclude=tmp --exclude=boot --exclude=home \
  --exclude=var/lib/docker --exclude=var/lib/containerd \
  --exclude=var/cache --exclude=var/log --exclude=var/tmp \
  --exclude=root/.cache --exclude=root/.npm \
  --exclude=usr/share/doc --exclude=usr/share/man \
  bin etc lib lib64 sbin usr var 2>/dev/null \
  | docker import \
      -c 'USER 1000:1000' \
      -c 'ENV PATH=/usr/local/bin:/usr/bin:/bin' \
      - "${IMAGE_TAG}"

echo "Built ${IMAGE_TAG}. Set DEVROOM_SANDBOX_IMAGE=${IMAGE_TAG}."
