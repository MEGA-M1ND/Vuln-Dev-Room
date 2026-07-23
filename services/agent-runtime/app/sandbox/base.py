"""Sandbox abstraction.

A Sandbox is a short-lived, isolated workspace for exactly one agent run. The
graph and tools depend only on this interface; the Docker implementation provides
the real isolation. There is intentionally NO host-execution implementation — if
Docker is unavailable a run fails with SANDBOX_UNAVAILABLE.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


class SandboxUnavailableError(Exception):
    """Raised when no real isolated sandbox can be provisioned."""


class SandboxError(Exception):
    """Generic sandbox operation failure."""


@dataclass
class CommandResult:
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool = False


@dataclass
class PatchResult:
    path: str
    applied: bool
    created: bool = False
    message: str = ""


@dataclass
class PreparedRepository:
    base_revision: str
    tree: list[str] = field(default_factory=list)


class Sandbox(Protocol):
    sandbox_id: str

    def prepare_repository(self, source_path: str) -> PreparedRepository: ...

    def read_file(self, rel_path: str) -> str: ...

    def search_repository(self, query: str, max_results: int = 50) -> list[str]: ...

    def apply_patch(self, rel_path: str, new_content: str) -> PatchResult: ...

    def run_tests(self, test_command: str) -> CommandResult: ...

    def get_git_diff(self) -> str: ...

    def get_git_status(self) -> str: ...

    def collect_logs(self) -> str: ...

    def cleanup(self) -> None: ...
