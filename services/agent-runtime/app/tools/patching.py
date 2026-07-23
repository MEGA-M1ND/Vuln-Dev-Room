"""apply_patch tool — the ONLY write surface the agent has.

Every write is checked against the repository's allow-list before it reaches the
sandbox. A path outside the allow-list (or one attempting traversal) is rejected
and never written.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.sandbox.base import Sandbox
from app.security.paths import PathNotAllowedError, assert_allowed


@dataclass
class AppliedPatch:
    path: str
    created: bool


def apply_patch(
    sandbox: Sandbox,
    allowed_paths: list[str],
    rel_path: str,
    new_content: str,
) -> AppliedPatch:
    normalized = assert_allowed(rel_path, allowed_paths)  # raises if not allowed
    result = sandbox.apply_patch(normalized, new_content)
    return AppliedPatch(path=result.path, created=result.created)


__all__ = ["apply_patch", "AppliedPatch", "PathNotAllowedError"]
