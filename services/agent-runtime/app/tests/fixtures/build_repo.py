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

FIXTURES_DIR = os.path.dirname(__file__)


def build_demo_repo(dest: str | None = None, template: str = "agentguard-demo") -> str:
    """Create a git repo from a fixture template directory and return its path.

    `template` names a sibling directory under app/tests/fixtures/ — e.g. the
    default "agentguard-demo" (no third-party dependencies) or "deps-demo"
    (has a requirements.txt, for exercising the sandbox's setup phase).
    """
    target = dest or tempfile.mkdtemp(prefix="devroom-fixture-")
    template_dir = os.path.join(FIXTURES_DIR, template)
    repo = os.path.join(target, template)
    # Never carry build artifacts into the fresh repo.
    shutil.copytree(
        template_dir,
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
        ["git", "commit", "-q", "-m", f"Initial {template} repo"],
        cwd=repo,
        check=True,
        env=env,
    )
    return repo
