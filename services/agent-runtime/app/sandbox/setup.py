"""Deterministic dependency-setup detection.

The install step (docker_sandbox.py) is the ONLY place in the pipeline that
ever gets network access, and it must never run a command influenced by the
model or by arbitrary repository content. This module enforces that by
returning one of a small, hardcoded set of argv lists, selected only by
*which* manifest file exists — never by that file's contents.

Adding a new ecosystem means adding another literal branch here, not making
this data-driven.
"""

from __future__ import annotations

import os

REQUIREMENTS_TXT = "requirements.txt"
PYPROJECT_TOML = "pyproject.toml"


def detect_install_command(repo_path: str) -> list[str] | None:
    """Return the fixed install argv for this repo, or None if no setup step
    is needed (the common case — e.g. the bundled demo fixture has no
    third-party dependencies at all)."""
    if os.path.isfile(os.path.join(repo_path, REQUIREMENTS_TXT)):
        return [
            "pip",
            "install",
            "--user",
            "--no-input",
            "--no-cache-dir",
            "-r",
            REQUIREMENTS_TXT,
        ]
    if os.path.isfile(os.path.join(repo_path, PYPROJECT_TOML)):
        return [
            "pip",
            "install",
            "--user",
            "--no-input",
            "--no-cache-dir",
            "-e",
            ".",
        ]
    return None
