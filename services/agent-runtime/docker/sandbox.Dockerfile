# Sandbox image for Dev Room agent runs.
#
# This is the DEFAULT image for normal environments (where Docker Hub is
# reachable). It contains only what a run needs: git + Python + pytest, and a
# non-root user. Build with:
#
#   docker build -f docker/sandbox.Dockerfile -t devroom-sandbox:latest .
#
# Then set DEVROOM_SANDBOX_IMAGE=devroom-sandbox:latest.
#
# NOTE: the container is always run with --network=none --cap-drop=ALL
# --read-only and resource limits by the runtime; this image only provides the
# toolchain.
FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir pytest

# Non-root user used by the sandbox (uid 1000).
RUN useradd --uid 1000 --create-home --shell /bin/bash agent

USER 1000:1000
WORKDIR /tmp
