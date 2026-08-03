"""Phase 1c: clone a room's connected repository on the runtime HOST.

This runs before the sandbox even exists. The host has network (the agent
sandbox never does — that boundary is untouched); the clone happens here, and
the result is handed to `Sandbox.prepare_repository()` as a plain local
directory, exactly like the static demo registry always has been. Nothing
downstream of that call knows or cares whether the source was a local path or
a fresh clone.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass

# GitHub owner/repo slugs: letters, digits, hyphens, underscores, dots. No
# slashes, no "..", no whitespace — this is what stands between a room's
# stored owner/repo and a shell-adjacent `git clone` argument, so it is
# deliberately strict rather than merely "probably fine".
_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")


class RepositorySourceError(Exception):
    """Raised when a repository cannot be resolved to a local checkout."""


@dataclass
class ClonedRepository:
    path: str
    revision: str


def github_https_url(owner: str, repo: str) -> str:
    """Build a github.com HTTPS clone URL from an owner/repo pair.

    Never accepts a caller-supplied URL — only the two path segments, each
    validated against a strict slug pattern, so a stored RepositoryConnection
    row can never smuggle extra `git` arguments or an arbitrary host.
    """
    if not _SLUG.match(owner) or not _SLUG.match(repo):
        raise RepositorySourceError(f"Invalid repository owner/repo: {owner!r}/{repo!r}")
    return f"https://github.com/{owner}/{repo}.git"


def clone_repository(
    clone_url: str,
    *,
    ref: str,
    pinned_sha: str | None,
    timeout: int,
) -> ClonedRepository:
    """Clone `clone_url` into a fresh temp directory.

    - With no `pinned_sha` (the first plan of a run): a shallow clone of `ref`,
      and the resulting HEAD becomes the pinned revision for this run.
    - With `pinned_sha` (resuming/replanning after approval): a full clone
      followed by a checkout of that exact commit, so the sandbox a human
      approved a plan against is byte-for-byte the same one edits are applied
      to — never whatever `ref` has since moved to.

    Raises RepositorySourceError on any failure; never leaves a partial
    directory behind (the caller doesn't need to clean up on failure, only
    on success once it is done with the checkout).
    """
    dest = tempfile.mkdtemp(prefix="devroom-clone-")
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    try:
        if pinned_sha:
            _git(["clone", "--quiet", clone_url, dest], timeout=timeout, env=env)
            _git(
                ["-C", dest, "checkout", "--quiet", pinned_sha],
                timeout=timeout,
                env=env,
            )
            revision = pinned_sha
        else:
            _git(
                ["clone", "--quiet", "--depth", "1", "--branch", ref, clone_url, dest],
                timeout=timeout,
                env=env,
            )
            revision = _git(
                ["-C", dest, "rev-parse", "HEAD"], timeout=timeout, env=env
            ).stdout.strip()
        return ClonedRepository(path=dest, revision=revision)
    except Exception:
        shutil.rmtree(dest, ignore_errors=True)
        raise


def list_tracked_files(path: str, *, timeout: int = 30) -> list[str]:
    """Git-tracked files at `path`, on the host — used only to detect the
    repo's language/test command before a sandbox exists. The sandbox lists
    its own copy of the tree independently once prepared."""
    result = _git(["-C", path, "ls-files"], timeout=timeout, env=os.environ.copy())
    return [line for line in result.stdout.splitlines() if line.strip()]


def _git(
    args: list[str], *, timeout: int, env: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    try:
        proc = subprocess.run(
            ["git", *args], capture_output=True, text=True, timeout=timeout, env=env
        )
    except subprocess.TimeoutExpired as exc:
        raise RepositorySourceError(f"git {args[0]} timed out after {timeout}s") from exc
    if proc.returncode != 0:
        raise RepositorySourceError(f"git {args[0]} failed: {proc.stderr.strip()}")
    return proc
