"""Phase 1 human-control invariants, exercised against a real sandbox.

These are the safety-critical guarantees:
  * cancelling stops work at a safe checkpoint and writes nothing,
  * cancelling before approval cannot cause a file write,
  * guidance (redirect) is consumed and changes the plan,
  * a redirect after approval invalidates it and returns to the gate.
"""

import os
import shutil

import pytest
from langgraph.checkpoint.memory import MemorySaver

from app.config import get_settings
from app.graph.backend_agent import (
    CollectingRecorder,
    RunCancelled,
    RunContext,
    _build_graph,
)
from app.models.fake_model import FakeModel
from app.sandbox.docker_sandbox import DockerSandbox
from app.tests.fixtures.build_repo import build_demo_repo
from app.tools.repository import Toolset


@pytest.fixture
def demo_repo():
    repo = build_demo_repo()
    yield repo
    shutil.rmtree(os.path.dirname(repo), ignore_errors=True)


def _toolset(sandbox):
    return Toolset(
        sandbox=sandbox,
        allowed_paths=["backend/**", "tests/**"],
        test_command="python -m pytest -q",
    )


def test_cancel_before_approval_writes_nothing(docker_required, demo_repo):
    """A run cancelled at the gate must leave the workspace untouched."""
    settings = get_settings()
    sandbox = DockerSandbox(settings)
    recorder = CollectingRecorder()
    try:
        sandbox.prepare_repository(demo_repo)
        # Cancellation is requested while the run sits at the approval gate.
        cancelled = {"value": False}
        ctx = RunContext(
            toolset=_toolset(sandbox),
            model=FakeModel(),
            language="python",
            recorder=recorder,
            should_cancel=lambda: cancelled["value"],
        )
        graph = _build_graph(ctx, MemorySaver())
        cfg = {"configurable": {"thread_id": "cancel-1"}}

        graph.invoke(
            {"run_id": "r", "ticket_title": "Implement", "ticket_description": ""},
            config=cfg,
        )
        # Parked before apply_edits, nothing written yet.
        assert graph.get_state(cfg).next == ("apply_edits",)
        assert sandbox.get_git_diff().strip() == ""

        # Now cancel and attempt to resume: the checkpoint must refuse.
        cancelled["value"] = True
        with pytest.raises(RunCancelled):
            graph.invoke(None, config=cfg)

        # Still nothing written, and no patch event was recorded.
        assert sandbox.get_git_diff().strip() == ""
        assert "FILE_PATCHED" not in [e[0] for e in recorder.events]
    finally:
        sandbox.cleanup()


def test_cancel_stops_before_tests_and_leaves_checkpoint(docker_required, demo_repo):
    """Cancelling mid-run stops at the next node boundary, not mid-write."""
    settings = get_settings()
    sandbox = DockerSandbox(settings)
    recorder = CollectingRecorder()
    try:
        sandbox.prepare_repository(demo_repo)
        # Trip cancellation only once edits have been applied, so the run stops
        # at the following checkpoint (run_tests) rather than mid-patch.
        state = {"cancel": False}

        def should_cancel() -> bool:
            return state["cancel"]

        ctx = RunContext(
            toolset=_toolset(sandbox),
            model=FakeModel(),
            language="python",
            recorder=recorder,
            should_cancel=should_cancel,
        )
        graph = _build_graph(ctx, MemorySaver())
        cfg = {"configurable": {"thread_id": "cancel-2"}}
        graph.invoke(
            {"run_id": "r", "ticket_title": "Implement", "ticket_description": ""},
            config=cfg,
        )

        # Approve, but request cancellation as soon as edits land.
        original_apply = ctx.toolset.apply_patch

        def apply_then_cancel(path: str, content: str):
            result = original_apply(path, content)
            state["cancel"] = True
            return result

        ctx.toolset.apply_patch = apply_then_cancel  # type: ignore[method-assign]

        with pytest.raises(RunCancelled):
            graph.invoke(None, config=cfg)

        events = [e[0] for e in recorder.events]
        assert "EDITS_STARTED" in events
        assert "FILE_PATCHED" in events
        # Stopped before the tests node ran.
        assert "TESTS_STARTED" not in events
    finally:
        sandbox.cleanup()


def test_redirect_guidance_is_consumed_and_replans(docker_required, demo_repo):
    """Pending guidance is claimed exactly once and reaches the model."""
    settings = get_settings()
    sandbox = DockerSandbox(settings)
    recorder = CollectingRecorder()

    seen: list[str] = []

    class RecordingModel(FakeModel):
        def propose_change(self, request):
            seen.append(request.description)
            return super().propose_change(request)

    try:
        sandbox.prepare_repository(demo_repo)
        pending = [{"id": "iv1", "guidance": "Prefer a helper method", "authorUserId": "u1"}]

        def take_redirects():
            # Mirrors the DB helper: claiming drains the queue.
            claimed = list(pending)
            pending.clear()
            return claimed

        ctx = RunContext(
            toolset=_toolset(sandbox),
            model=RecordingModel(),
            language="python",
            recorder=recorder,
            take_redirects=take_redirects,
        )
        graph = _build_graph(ctx, MemorySaver())
        cfg = {"configurable": {"thread_id": "redirect-1"}}
        graph.invoke(
            {"run_id": "r", "ticket_title": "Implement", "ticket_description": "base"},
            config=cfg,
        )

        # Guidance reached the model and was recorded as applied.
        assert "Prefer a helper method" in seen[0]
        assert "REDIRECT_APPLIED" in [e[0] for e in recorder.events]
        # Consumed exactly once.
        assert pending == []
        # And the run is back at the approval gate, not applying edits.
        assert graph.get_state(cfg).next == ("apply_edits",)
        assert sandbox.get_git_diff().strip() == ""
    finally:
        sandbox.cleanup()


def test_replan_after_approval_returns_to_gate(docker_required, demo_repo):
    """Re-planning rewinds to the gate so a stale approval cannot be applied."""
    settings = get_settings()
    sandbox = DockerSandbox(settings)
    recorder = CollectingRecorder()
    try:
        sandbox.prepare_repository(demo_repo)
        ctx = RunContext(
            toolset=_toolset(sandbox),
            model=FakeModel(),
            language="python",
            recorder=recorder,
        )
        graph = _build_graph(ctx, MemorySaver())
        cfg = {"configurable": {"thread_id": "replan-1"}}
        graph.invoke(
            {"run_id": "r", "ticket_title": "Implement", "ticket_description": ""},
            config=cfg,
        )
        assert graph.get_state(cfg).next == ("apply_edits",)

        # Simulate the redirect rewind used by replan_run().
        graph.update_state(cfg, {}, as_node="inspect_repository")
        assert graph.get_state(cfg).next == ("plan_change",)

        graph.invoke(None, config=cfg)
        # Back at the gate with a fresh plan; still nothing written.
        assert graph.get_state(cfg).next == ("apply_edits",)
        assert sandbox.get_git_diff().strip() == ""
    finally:
        sandbox.cleanup()
