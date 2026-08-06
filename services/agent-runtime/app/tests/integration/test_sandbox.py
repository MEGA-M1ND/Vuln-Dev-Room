import shutil
import os
import subprocess

import pytest

from app.config import get_settings
from app.models.base import PlanRequest
from app.models.fake_model import FakeModel
from app.sandbox.base import SandboxSetupError
from app.sandbox.docker_sandbox import DockerSandbox
from app.tests.fixtures.build_repo import build_demo_repo

# Never resolves on PyPI — used to exercise the setup-failure path
# deterministically, without depending on a real package disappearing.
_NONEXISTENT_PACKAGE = "devroom-test-nonexistent-package-a1b2c3"

# No network interface at all under --network=none: even a connect() to a
# well-known, always-up IP fails immediately (ENETUNREACH), not merely slowly.
_NETWORK_PROBE = (
    "python3 -c \"import socket; "
    "socket.create_connection(('1.1.1.1', 80), timeout=3)\""
)


@pytest.fixture
def demo_repo():
    repo = build_demo_repo()
    yield repo
    shutil.rmtree(os.path.dirname(repo), ignore_errors=True)


@pytest.fixture
def deps_repo():
    """demo-service's counterpart WITH a requirements.txt — exercises the
    setup phase, unlike demo_repo which never triggers one."""
    repo = build_demo_repo(template="deps-demo")
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


def test_no_manifest_skips_setup_phase(docker_required, demo_repo):
    """demo-service has no requirements.txt/pyproject.toml — behaviour must
    be byte-for-byte what it was before Phase 1a."""
    settings = get_settings()
    sb = DockerSandbox(settings)
    try:
        prepared = sb.prepare_repository(demo_repo)
        assert prepared.dependencies_installed is False
        assert prepared.setup_output == ""
        assert sb._snapshot_image is None  # noqa: SLF001 — asserting no image lingers
    finally:
        sb.cleanup()


def test_agent_phase_has_no_network(docker_required, demo_repo):
    """The core Phase 1a invariant: the container the agent actually runs
    edits/tests in must never have network access, with or without a setup
    phase having run first."""
    settings = get_settings()
    sb = DockerSandbox(settings)
    try:
        sb.prepare_repository(demo_repo)
        probe = sb.run_tests(_NETWORK_PROBE)
        assert probe.exit_code != 0
    finally:
        sb.cleanup()


def test_flag_disabled_skips_setup_even_with_a_manifest(docker_required, deps_repo):
    """DEVROOM_DEPENDENCY_SETUP_ENABLED is off by default in production;
    verify the gate itself, independent of whatever CI's own environment sets
    it to, by constructing Settings directly."""
    settings = get_settings().model_copy(update={"dependency_setup_enabled": False})
    sb = DockerSandbox(settings)
    try:
        prepared = sb.prepare_repository(deps_repo)
        assert prepared.dependencies_installed is False
        assert sb._snapshot_image is None  # noqa: SLF001
    finally:
        sb.cleanup()


def test_setup_phase_installs_dependency_and_agent_phase_stays_isolated(
    docker_required, deps_repo
):
    settings = get_settings()
    sb = DockerSandbox(settings)
    try:
        prepared = sb.prepare_repository(deps_repo)

        # The setup phase ran and actually installed the declared dependency.
        assert prepared.dependencies_installed is True
        assert "six" in prepared.setup_output
        assert sb._snapshot_image is not None  # noqa: SLF001

        # The installed dependency is importable in the agent-phase container
        # — i.e. it survived docker commit and isn't shadowed by the tmpfs
        # mounted over /tmp there.
        result = sb.run_tests("python -m pytest -q")
        assert result.exit_code == 0, result.stdout + result.stderr

        # Snapshotting for dependencies must not have reopened the network in
        # the container the agent actually runs in.
        probe = sb.run_tests(_NETWORK_PROBE)
        assert probe.exit_code != 0
    finally:
        snapshot = sb._snapshot_image  # noqa: SLF001
        sb.cleanup()
        # cleanup() must have removed the per-run image, not just the container.
        if snapshot:
            inspect = subprocess.run(
                ["docker", "image", "inspect", snapshot], capture_output=True
            )
            assert inspect.returncode != 0, "snapshot image was not removed by cleanup()"


def test_setup_phase_failure_raises_setup_error(docker_required, tmp_path):
    repo = tmp_path / "broken-deps"
    repo.mkdir()
    (repo / "requirements.txt").write_text(f"{_NONEXISTENT_PACKAGE}==0.0.0\n")
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True, env=env)
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True, env=env)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo, check=True, env=env)

    settings = get_settings()
    sb = DockerSandbox(settings)
    try:
        with pytest.raises(SandboxSetupError):
            sb.prepare_repository(str(repo))
    finally:
        sb.cleanup()
