"""get_git_diff tool — captures the unified diff of the agent's changes."""

from __future__ import annotations

from app.sandbox.base import Sandbox
from app.security.redaction import redact


def get_git_diff(sandbox: Sandbox) -> str:
    return redact(sandbox.get_git_diff())


def get_git_status(sandbox: Sandbox) -> str:
    return redact(sandbox.get_git_status())
