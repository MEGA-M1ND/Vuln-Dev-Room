"""Read-side repository tools + the constrained Toolset facade.

The agent's ENTIRE capability surface is these six tools:
  list_repository, read_file, search_repository, apply_patch,
  run_project_tests, get_git_diff
There is intentionally no "run arbitrary command" or "read arbitrary host path".
"""

from __future__ import annotations

from dataclasses import dataclass

from app.sandbox.base import Sandbox
from app.security.paths import assert_allowed
from app.tools.diff import get_git_diff, get_git_status
from app.tools.patching import AppliedPatch, apply_patch
from app.tools.tests import TestOutcome, run_project_tests


def list_repository(sandbox: Sandbox) -> list[str]:
    # DockerSandbox exposes list_tree(); fall back gracefully for other impls.
    lister = getattr(sandbox, "list_tree", None)
    if callable(lister):
        return lister()
    return []


def read_file(sandbox: Sandbox, rel_path: str) -> str:
    # Reads are permitted anywhere inside the workspace (path is still normalized
    # to prevent traversal); writes are the allow-listed operation.
    from app.security.paths import normalize_relative

    return sandbox.read_file(normalize_relative(rel_path))


def search_repository(sandbox: Sandbox, query: str, max_results: int = 50) -> list[str]:
    return sandbox.search_repository(query, max_results=max_results)


@dataclass
class Toolset:
    """Binds a sandbox + the repository allow-list/test command into the exact,
    minimal set of operations the graph may perform."""

    sandbox: Sandbox
    allowed_paths: list[str]
    test_command: str

    def list_repository(self) -> list[str]:
        return list_repository(self.sandbox)

    def read_file(self, rel_path: str) -> str:
        return read_file(self.sandbox, rel_path)

    def search_repository(self, query: str, max_results: int = 50) -> list[str]:
        return search_repository(self.sandbox, query, max_results=max_results)

    def apply_patch(self, rel_path: str, new_content: str) -> AppliedPatch:
        return apply_patch(self.sandbox, self.allowed_paths, rel_path, new_content)

    def run_project_tests(self) -> TestOutcome:
        return run_project_tests(self.sandbox, self.test_command)

    def get_git_diff(self) -> str:
        return get_git_diff(self.sandbox)

    def get_git_status(self) -> str:
        return get_git_status(self.sandbox)

    def is_allowed(self, rel_path: str) -> bool:
        from app.security.paths import PathNotAllowedError

        try:
            assert_allowed(rel_path, self.allowed_paths)
            return True
        except PathNotAllowedError:
            return False
