import os
import shutil

import pytest
from langgraph.checkpoint.memory import MemorySaver

from app.config import get_settings
from app.graph.backend_agent import CollectingRecorder, RunContext, _build_graph
from app.models.fake_model import FakeModel
from app.sandbox.docker_sandbox import DockerSandbox
from app.tests.fixtures.build_repo import build_demo_repo
from app.tools.repository import Toolset


@pytest.fixture
def demo_repo():
    repo = build_demo_repo()
    yield repo
    shutil.rmtree(os.path.dirname(repo), ignore_errors=True)


def test_backend_agent_graph_end_to_end(docker_required, demo_repo):
    settings = get_settings()
    sandbox = DockerSandbox(settings)
    recorder = CollectingRecorder()
    try:
        prepared = sandbox.prepare_repository(demo_repo)
        toolset = Toolset(
            sandbox=sandbox,
            allowed_paths=["backend/**", "tests/**"],
            test_command="python -m pytest -q",
        )
        ctx = RunContext(
            toolset=toolset, model=FakeModel(), language="python", recorder=recorder
        )
        graph = _build_graph(ctx, MemorySaver())
        cfg = {"configurable": {"thread_id": "t-1"}}

        # Phase 1: runs inspect + plan, then PAUSES before apply_edits (the
        # Stage 3 approval gate). No file has been written yet.
        graph.invoke(
            {
                "run_id": "test-run",
                "ticket_title": "Implement token bucket",
                "ticket_description": "",
                "base_revision": prepared.base_revision,
            },
            config=cfg,
        )
        paused = graph.get_state(cfg)
        assert paused.next == ("apply_edits",)  # gated before writing
        assert paused.values.get("proposed_edits")  # plan is ready
        assert "FILE_PATCHED" not in [e[0] for e in recorder.events]
        assert sandbox.get_git_diff().strip() == ""  # nothing written pre-approval

        # Phase 2: approve -> resume applies the checkpointed plan and finishes.
        final = graph.invoke(None, config=cfg)

        # State reflects a real, verified change.
        assert final["applied_paths"] == ["backend/rate_limiter.py"]
        assert final["tests_passed"] is True
        assert "return self._consume()" in final["diff_text"]
        assert final["summary_text"]

        # Durable artifacts + events were recorded (via the collecting recorder).
        artifact_types = {a["type"] for a in recorder.artifacts}
        assert {"PLAN", "TEST_RESULT", "DIFF", "SUMMARY"} <= artifact_types

        event_types = [e[0] for e in recorder.events]
        for expected in [
            "REPOSITORY_INSPECTED",
            "PLAN_CREATED",
            "FILE_PATCHED",
            "TESTS_STARTED",
            "TESTS_FINISHED",
            "DIFF_CAPTURED",
        ]:
            assert expected in event_types
    finally:
        sandbox.cleanup()


def test_diff_artifact_records_reviewed_file_contents(docker_required, demo_repo):
    """Delivery applies the reviewed content, so the run must record it.

    The DIFF artifact carries both the human-readable diff and the exact file
    contents that were approved and applied — never a reconstruction.
    """
    settings = get_settings()
    sandbox = DockerSandbox(settings)
    recorder = CollectingRecorder()
    try:
        sandbox.prepare_repository(demo_repo)
        toolset = Toolset(
            sandbox=sandbox,
            allowed_paths=["backend/**", "tests/**"],
            test_command="python -m pytest -q",
        )
        ctx = RunContext(
            toolset=toolset, model=FakeModel(), language="python", recorder=recorder
        )
        graph = _build_graph(ctx, MemorySaver())
        cfg = {"configurable": {"thread_id": "diff-json-1"}}
        graph.invoke(
            {"run_id": "r", "ticket_title": "Implement", "ticket_description": ""},
            config=cfg,
        )
        graph.invoke(None, config=cfg)  # approve the gate

        diff_artifacts = [a for a in recorder.artifacts if a["type"] == "DIFF"]
        assert len(diff_artifacts) == 1
        payload = diff_artifacts[0]["content_json"]
        files = payload["files"]
        assert [f["path"] for f in files] == ["backend/rate_limiter.py"]
        # The recorded content is the applied implementation, not the stub.
        assert "return self._consume()" in files[0]["content"]
        assert "raise NotImplementedError" not in files[0]["content"]
    finally:
        sandbox.cleanup()
