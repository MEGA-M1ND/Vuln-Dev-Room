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
        final = graph.invoke(
            {
                "run_id": "test-run",
                "ticket_title": "Implement token bucket",
                "ticket_description": "",
                "base_revision": prepared.base_revision,
            },
            config={"configurable": {"thread_id": "t-1"}},
        )

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
