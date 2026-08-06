"""Phase 1c exit criterion: clone a repo the agent has never seen before, and
get a plan that references a file it had to go find — exercised against a
local git repo (offline, deterministic) reached through the exact same
clone_repository() path a real github.com HTTPS URL would use.
"""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest
from langgraph.checkpoint.memory import MemorySaver

from app.config import get_settings
from app.graph.backend_agent import CollectingRecorder, RunContext, _build_graph
from app.models.fake_model import FakeModel
from app.repository.clone import clone_repository, list_tracked_files
from app.repository.detect import detect_language_and_test_command
from app.sandbox.docker_sandbox import DockerSandbox
from app.tools.repository import Toolset


@pytest.fixture
def remote_repo(tmp_path):
    """A repo the test process has never touched before this fixture runs —
    same shape as the demo fixture (a marked stub + the agent must find it),
    but never passed to the pipeline as a pre-known local path."""
    work = tmp_path / "remote"
    work.mkdir()
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "Test",
        "GIT_AUTHOR_EMAIL": "test@example.com",
        "GIT_COMMITTER_NAME": "Test",
        "GIT_COMMITTER_EMAIL": "test@example.com",
    }
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=work, check=True, env=env)
    # Empty on purpose: enough for detect_language_and_test_command to see a
    # Python marker, but — unlike a bare pyproject.toml with no [build-system]
    # — trivially and correctly `pip install`-able, so this exercises Phase
    # 1a's setup phase (when DEVROOM_DEPENDENCY_SETUP_ENABLED is on, as CI sets
    # it globally) without tripping an unrelated packaging failure.
    (work / "requirements.txt").write_text("")
    pkg = work / "pkg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "limiter.py").write_text(
        "class Limiter:\n"
        "    def allow(self):\n"
        "        raise NotImplementedError  # devroom:implement True\n"
    )
    subprocess.run(["git", "add", "-A"], cwd=work, check=True, env=env)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=work, check=True, env=env)
    return str(work)


def test_clone_then_full_graph_run_produces_a_plan_from_a_file_the_agent_had_to_find(
    docker_required, remote_repo
):
    cloned = clone_repository(remote_repo, ref="main", pinned_sha=None, timeout=30)
    try:
        tree = list_tracked_files(cloned.path)
        language, _test_command = detect_language_and_test_command(tree)
        assert language == "python"

        settings = get_settings()
        sandbox = DockerSandbox(settings)
        recorder = CollectingRecorder()
        try:
            sandbox.prepare_repository(cloned.path)
            # No test command is exercised here — the graph is stopped at the
            # approval gate before apply_edits/run_tests ever run.
            toolset = Toolset(sandbox=sandbox, allowed_paths=["**"], test_command="true")
            ctx = RunContext(
                toolset=toolset, model=FakeModel(), language=language, recorder=recorder
            )
            graph = _build_graph(ctx, MemorySaver())
            cfg = {"configurable": {"thread_id": "clone-e2e"}}
            graph.invoke(
                {
                    "run_id": "r",
                    "task_title": "Implement the rate limiter",
                    "task_description": "",
                },
                config=cfg,
            )

            state = graph.get_state(cfg)
            assert state.next == ("apply_edits",)  # paused at the approval gate
            proposed = state.values["proposed_edits"]
            assert proposed, "expected a plan referencing the file the agent found"
            assert proposed[0]["path"] == "pkg/limiter.py"
            assert "return True" in proposed[0]["new_content"]
        finally:
            sandbox.cleanup()
    finally:
        shutil.rmtree(cloned.path, ignore_errors=True)
