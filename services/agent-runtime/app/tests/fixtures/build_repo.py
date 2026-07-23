"""Build a throwaway Git repository from the fixture template.

The committed fixture is a plain directory of files (no `.git`, so it does not
pollute the outer repository). This helper materializes it into a temporary Git
repository, which is what a real configured `source_path` would be.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), "agentguard-demo")


def build_demo_repo(dest: str | None = None) -> str:
    """Create a git repo from the template and return its path."""
    target = dest or tempfile.mkdtemp(prefix="devroom-fixture-")
    repo = os.path.join(target, "agentguard-demo")
    # Never carry build artifacts into the fresh repo.
    shutil.copytree(
        TEMPLATE_DIR,
        repo,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache"),
    )
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "Demo",
        "GIT_AUTHOR_EMAIL": "demo@devroom.local",
        "GIT_COMMITTER_NAME": "Demo",
        "GIT_COMMITTER_EMAIL": "demo@devroom.local",
    }
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True, env=env)
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True, env=env)
    subprocess.run(
        ["git", "commit", "-q", "-m", "Initial AgentGuard demo repo"],
        cwd=repo,
        check=True,
        env=env,
    )
    return repo
