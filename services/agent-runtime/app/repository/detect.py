"""Phase 1c: detect language + test command from a cloned repo's shape.

Runs after clone, before the sandbox is prepared — it only needs the file
tree, not file contents, so it is a pure function over `git ls-files` output
exactly like the dependency-manifest detection in `app/sandbox/setup.py`.
Python only this phase: a repo with no Python markers fails clearly rather
than silently running `pytest` against a project it can't possibly test.
"""

from __future__ import annotations

# Root-level files that mark a Python project. Checked at the repo root only
# (a nested `pyproject.toml` inside a vendored dependency shouldn't count).
_ROOT_PYTHON_MARKERS = {
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "setup.cfg",
    "Pipfile",
}


class UnsupportedRepositoryError(Exception):
    """Raised when a repository's shape isn't one this phase can run against."""


def detect_language_and_test_command(tree: list[str]) -> tuple[str, str]:
    """Return (language, test_command) for a cloned repo's file tree.

    Python only: any root-level Python manifest, or failing that any `.py`
    file at all, is enough to proceed with the standard `pytest -q`. A repo
    with neither raises UnsupportedRepositoryError — Node/other ecosystems are
    explicitly out of scope for this phase (see docs/ROADMAP.md, Phase 1c).
    """
    has_root_manifest = any(path in _ROOT_PYTHON_MARKERS for path in tree)
    has_python_files = any(path.endswith(".py") for path in tree)
    if not has_root_manifest and not has_python_files:
        raise UnsupportedRepositoryError(
            "This repository doesn't look like a Python project (no "
            "pyproject.toml/requirements.txt/setup.py and no .py files). "
            "Only Python repositories are supported so far."
        )
    return "python", "pytest -q"
