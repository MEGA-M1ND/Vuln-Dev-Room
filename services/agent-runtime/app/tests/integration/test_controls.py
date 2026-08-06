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
    RunRedirected,
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
            {"run_id": "r", "task_title": "Implement", "task_description": ""},
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
            {"run_id": "r", "task_title": "Implement", "task_description": ""},
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
            {"run_id": "r", "task_title": "Implement", "task_description": "base"},
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
            {"run_id": "r", "task_title": "Implement", "task_description": ""},
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


# --- Phase 3: mid-node steering ---------------------------------------------
#
# Guidance can now interrupt a run that has already passed the approval gate
# and is actively applying edits / running tests / capturing its diff — not
# only one still waiting at the gate. These prove the same safety invariant
# cancellation already has: the checkpoint fires only *between* nodes, so a
# steered run never has a partial write.


def test_steering_mid_apply_edits_aborts_before_any_write(docker_required, demo_repo):
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
            has_pending_redirect=lambda: True,
        )
        graph = _build_graph(ctx, MemorySaver())
        cfg = {"configurable": {"thread_id": "steer-apply-edits"}}
        graph.invoke(
            {"run_id": "r", "task_title": "Implement", "task_description": ""},
            config=cfg,
        )
        assert graph.get_state(cfg).next == ("apply_edits",)

        # Approved, but guidance is already pending before apply_edits' own
        # checkpoint runs.
        with pytest.raises(RunRedirected) as exc_info:
            graph.invoke(None, config=cfg)
        assert exc_info.value.node == "apply_edits"

        # The checkpoint fires at the TOP of the node — nothing was written.
        assert sandbox.get_git_diff().strip() == ""
        assert "FILE_PATCHED" not in [e[0] for e in recorder.events]
    finally:
        sandbox.cleanup()


def test_steering_mid_run_tests_aborts_after_edits_already_applied(
    docker_required, demo_repo
):
    """Guidance arriving after apply_edits has already run aborts at the next
    checkpoint (run_tests) — the edits from the now-abandoned attempt stay
    written to this (about-to-be-discarded) sandbox, but tests never run."""
    settings = get_settings()
    sandbox = DockerSandbox(settings)
    recorder = CollectingRecorder()
    try:
        sandbox.prepare_repository(demo_repo)
        calls = {"n": 0}

        def has_pending_redirect() -> bool:
            calls["n"] += 1
            return calls["n"] > 1  # False for apply_edits' checkpoint, then True

        ctx = RunContext(
            toolset=_toolset(sandbox),
            model=FakeModel(),
            language="python",
            recorder=recorder,
            has_pending_redirect=has_pending_redirect,
        )
        graph = _build_graph(ctx, MemorySaver())
        cfg = {"configurable": {"thread_id": "steer-run-tests"}}
        graph.invoke(
            {"run_id": "r", "task_title": "Implement", "task_description": ""},
            config=cfg,
        )
        assert graph.get_state(cfg).next == ("apply_edits",)

        with pytest.raises(RunRedirected) as exc_info:
            graph.invoke(None, config=cfg)
        assert exc_info.value.node == "run_tests"

        events = [e[0] for e in recorder.events]
        assert "FILE_PATCHED" in events  # apply_edits completed
        assert "TESTS_STARTED" not in events  # run_tests aborted before running
    finally:
        sandbox.cleanup()


def test_steering_mid_capture_diff_aborts_after_tests_already_ran(
    docker_required, demo_repo
):
    settings = get_settings()
    sandbox = DockerSandbox(settings)
    recorder = CollectingRecorder()
    try:
        sandbox.prepare_repository(demo_repo)
        calls = {"n": 0}

        def has_pending_redirect() -> bool:
            calls["n"] += 1
            return calls["n"] > 2  # False for apply_edits + run_tests, then True

        ctx = RunContext(
            toolset=_toolset(sandbox),
            model=FakeModel(),
            language="python",
            recorder=recorder,
            has_pending_redirect=has_pending_redirect,
        )
        graph = _build_graph(ctx, MemorySaver())
        cfg = {"configurable": {"thread_id": "steer-capture-diff"}}
        graph.invoke(
            {"run_id": "r", "task_title": "Implement", "task_description": ""},
            config=cfg,
        )
        assert graph.get_state(cfg).next == ("apply_edits",)

        with pytest.raises(RunRedirected) as exc_info:
            graph.invoke(None, config=cfg)
        assert exc_info.value.node == "capture_diff"

        events = [e[0] for e in recorder.events]
        assert "TESTS_FINISHED" in events  # run_tests completed
        assert "DIFF_CAPTURED" not in events  # capture_diff aborted before running
    finally:
        sandbox.cleanup()


def test_steering_never_fires_for_plan_change_or_inspect(docker_required, demo_repo):
    """Pending guidance before the gate is handled by plan_change's own
    take_redirects — the steerable checkpoint must not also fire there, or a
    run would never even reach its first plan."""
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
            has_pending_redirect=lambda: True,  # pending the entire time
        )
        graph = _build_graph(ctx, MemorySaver())
        cfg = {"configurable": {"thread_id": "steer-not-before-gate"}}
        # inspect_repository + plan_change run despite guidance being
        # "pending" throughout — RunRedirected must not fire before the gate.
        graph.invoke(
            {"run_id": "r", "task_title": "Implement", "task_description": ""},
            config=cfg,
        )
        assert graph.get_state(cfg).next == ("apply_edits",)
    finally:
        sandbox.cleanup()
