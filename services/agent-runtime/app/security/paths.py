"""Path safety.

The agent may only read/write files that (a) resolve inside the sandbox
workspace and (b) match one of the repository's configured `allowed_paths`
globs. This module is pure and unit-tested; it is the single source of truth for
"is this path allowed".
"""

from __future__ import annotations

import posixpath
from fnmatch import fnmatch


class PathNotAllowedError(Exception):
    """Raised when a path escapes the workspace or is not allow-listed."""


def normalize_relative(path: str) -> str:
    """Normalize a repo-relative path, rejecting absolute paths and traversal.

    Returns a clean forward-slash relative path (e.g. ``backend/app.py``).
    """
    if path is None:
        raise PathNotAllowedError("Path is required.")
    p = path.strip().replace("\\", "/")
    if not p:
        raise PathNotAllowedError("Path is empty.")
    if p.startswith("/"):
        raise PathNotAllowedError(f"Absolute paths are not allowed: {path!r}")
    if "\x00" in p:
        raise PathNotAllowedError("Path contains a null byte.")

    normalized = posixpath.normpath(p)
    # normpath collapses `a/../b` etc. Any result that climbs out is rejected.
    if normalized == ".." or normalized.startswith("../") or "/../" in normalized:
        raise PathNotAllowedError(f"Path traversal is not allowed: {path!r}")
    if normalized.startswith("/"):
        raise PathNotAllowedError(f"Absolute paths are not allowed: {path!r}")
    if normalized == ".":
        raise PathNotAllowedError("Path may not reference the workspace root.")
    return normalized


def matches_allowed(path: str, allowed_globs: list[str]) -> bool:
    """Whether a normalized relative path matches any allow-list glob.

    Globs use shell semantics with an added convention: a trailing ``/**``
    matches the directory and everything under it (e.g. ``backend/**`` matches
    ``backend/app.py`` and ``backend/sub/x.py``).
    """
    normalized = normalize_relative(path)
    for glob in allowed_globs:
        g = glob.strip().replace("\\", "/")
        if not g:
            continue
        if fnmatch(normalized, g):
            return True
        if g.endswith("/**"):
            prefix = g[:-3]
            if normalized == prefix or normalized.startswith(prefix + "/"):
                return True
        # `**` anywhere: fall back to fnmatch which treats * as any-non-sep; do a
        # permissive translation for the common `dir/**/file` case.
        if "**" in g:
            simple = g.replace("**/", "").replace("/**", "").replace("**", "*")
            if fnmatch(normalized, simple):
                return True
    return False


def assert_allowed(path: str, allowed_globs: list[str]) -> str:
    normalized = normalize_relative(path)
    if not matches_allowed(normalized, allowed_globs):
        raise PathNotAllowedError(
            f"Path {normalized!r} is not within the allowed paths for this repository."
        )
    return normalized
