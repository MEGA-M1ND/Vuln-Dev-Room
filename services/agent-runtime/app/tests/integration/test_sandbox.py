import shutil
import os

import pytest

from app.config import get_settings
from app.models.base import PlanRequest
from app.models.fake_model import FakeModel
from app.sandbox.docker_sandbox import DockerSandbox
from app.tests.fixtures.build_repo import build_demo_repo


@pytest.fixture
def demo_repo():
    repo = build_demo_repo()
    yield repo
    shutil.rmtree(os.path.dirname(repo), ignore_errors=True)


def test_sandbox_runs_real_change(docker_required, demo_repo):
    settings = get_settings()
    sb = DockerSandbox(settings)
    try:
        prepared = sb.prepare_repository(demo_repo)
        assert prepared.base_revision  # captured a real revision
        assert "backend/rate_limiter.py" in prepared.tree

        # Tests fail before the change.
        before = sb.run_tests("python -m pytest -q")
        assert before.exit_code != 0

        content = sb.read_file("backend/rate_limiter.py")
        edits = FakeModel().propose_change(
            PlanRequest(
                title="impl",
                description="",
                language="python",
                repo_tree=prepared.tree,
                file_excerpts={"backend/rate_limiter.py": content},
            )
        ).edits
        assert edits
        for e in edits:
            sb.apply_patch(e.path, e.new_content)

        # Tests pass after the change.
        after = sb.run_tests("python -m pytest -q")
        assert after.exit_code == 0

        diff = sb.get_git_diff()
        assert "backend/rate_limiter.py" in diff
        assert "return self._consume()" in diff
        # No build-artifact noise in the diff.
        assert "__pycache__" not in diff
    finally:
        sb.cleanup()


def test_prepare_rejects_non_git_dir(docker_required, tmp_path):
    settings = get_settings()
    sb = DockerSandbox(settings)
    (tmp_path / "not_a_repo").mkdir()
    try:
        with pytest.raises(Exception):
            sb.prepare_repository(str(tmp_path / "not_a_repo"))
    finally:
        sb.cleanup()
