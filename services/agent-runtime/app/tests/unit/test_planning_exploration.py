"""Phase 1b: the bounded tool-calling exploration loop in plan_change.

Uses an in-memory stub sandbox (no Docker) so these run everywhere, unlike the
Docker-gated end-to-end graph tests.
"""

from __future__ import annotations

from langgraph.checkpoint.memory import MemorySaver

from app.graph.backend_agent import CollectingRecorder, RunContext, _build_graph
from app.graph.prompts import MAX_PLANNING_TOOL_CALLS
from app.models.base import Model, PlanRequest, PlanResult, ToolCall
from app.sandbox.base import SandboxError
from app.tools.repository import Toolset


class StubSandbox:
    """Minimal in-memory sandbox double exposing just the read-side tools."""

    sandbox_id = "stub"

    def __init__(self, tree: list[str], files: dict[str, str]) -> None:
        self._tree = tree
        self._files = files

    def list_tree(self) -> list[str]:
        return list(self._tree)

    def read_file(self, rel_path: str) -> str:
        if rel_path not in self._files:
            raise SandboxError(f"no such file: {rel_path}")
        return self._files[rel_path]

    def search_repository(self, query: str, max_results: int = 50) -> list[str]:
        return [p for p, c in self._files.items() if query in c][:max_results]


def _toolset(sandbox: StubSandbox) -> Toolset:
    return Toolset(sandbox=sandbox, allowed_paths=["**"], test_command="pytest")


def _graph_and_cfg(model: Model, sandbox: StubSandbox):
    recorder = CollectingRecorder()
    ctx = RunContext(toolset=_toolset(sandbox), model=model, language="python", recorder=recorder)
    graph = _build_graph(ctx, MemorySaver())
    cfg = {"configurable": {"thread_id": "t"}}
    return graph, cfg, recorder


class NeverExploresModel(Model):
    """Doesn't override next_tool_call — inherits the default (always None)."""

    name = "never-explores"

    def propose_change(self, request: PlanRequest) -> PlanResult:
        return PlanResult(plan_text="no-op plan", edits=[])


def test_model_without_exploration_hook_makes_no_tool_calls():
    sandbox = StubSandbox(tree=["a.py"], files={"a.py": "print(1)\n"})
    graph, cfg, recorder = _graph_and_cfg(NeverExploresModel(), sandbox)

    graph.invoke({"run_id": "r", "task_title": "t", "task_description": ""}, config=cfg)

    event_types = [e[0] for e in recorder.events]
    assert "TOOL_CALL" not in event_types
    assert "REPO_EXPLORATION_FINISHED" not in event_types
    assert "PLAN_CREATED" in event_types


class AlwaysExploresModel(Model):
    """Never says "done" — used to prove the loop is actually bounded."""

    name = "always-explores"

    def next_tool_call(self, request: PlanRequest, history):
        return ToolCall(tool="list_repository")

    def propose_change(self, request: PlanRequest) -> PlanResult:
        return PlanResult(plan_text="no-op plan", edits=[])


def test_exploration_loop_is_capped_at_max_tool_calls():
    sandbox = StubSandbox(tree=["a.py"], files={"a.py": "print(1)\n"})
    graph, cfg, recorder = _graph_and_cfg(AlwaysExploresModel(), sandbox)

    graph.invoke({"run_id": "r", "task_title": "t", "task_description": ""}, config=cfg)

    tool_call_events = [e for e in recorder.events if e[0] == "TOOL_CALL"]
    assert len(tool_call_events) == MAX_PLANNING_TOOL_CALLS

    finished = [e for e in recorder.events if e[0] == "REPO_EXPLORATION_FINISHED"]
    assert len(finished) == 1
    assert finished[0][1]["toolCalls"] == MAX_PLANNING_TOOL_CALLS

    # The loop stopped and a plan was still produced, not left hanging.
    assert "PLAN_CREATED" in [e[0] for e in recorder.events]


class ReadTwoFilesModel(Model):
    """Reads two specific files, then stops. Captures what propose_change saw."""

    name = "read-two-files"

    def __init__(self) -> None:
        self.seen_excerpts: dict[str, str] | None = None

    def next_tool_call(self, request: PlanRequest, history):
        read_paths = {c.args.get("path") for c, _ in history if c.tool == "read_file"}
        remaining = [p for p in ("a.py", "b.py") if p not in read_paths]
        if not remaining:
            return None
        return ToolCall(tool="read_file", args={"path": remaining[0]})

    def propose_change(self, request: PlanRequest) -> PlanResult:
        self.seen_excerpts = dict(request.file_excerpts)
        return PlanResult(plan_text="plan", edits=[])


def test_read_file_results_are_fed_back_into_the_final_plan_request():
    sandbox = StubSandbox(
        tree=["a.py", "b.py", "c.py"],
        files={"a.py": "content-a", "b.py": "content-b", "c.py": "content-c"},
    )
    model = ReadTwoFilesModel()
    graph, cfg, recorder = _graph_and_cfg(model, sandbox)

    graph.invoke({"run_id": "r", "task_title": "t", "task_description": ""}, config=cfg)

    assert model.seen_excerpts == {"a.py": "content-a", "b.py": "content-b"}
    tool_calls = [e for e in recorder.events if e[0] == "TOOL_CALL"]
    assert [e[1]["args"]["path"] for e in tool_calls] == ["a.py", "b.py"]


def test_replan_does_not_re_explore_the_repository():
    """A redirect at the gate re-plans without touching the sandbox again —
    the exploration loop must run at most once per run, not once per plan."""
    sandbox = StubSandbox(tree=["a.py"], files={"a.py": "content-a"})
    model = ReadTwoFilesModel()  # will keep wanting b.py forever since it never reads it
    # Give it only "a.py" so it asks for "b.py" too, but b.py doesn't exist —
    # SandboxError is caught and fed back as an error string, still counts as
    # a call, and the loop still terminates via the MAX_PLANNING_TOOL_CALLS cap.
    graph, cfg, recorder = _graph_and_cfg(model, sandbox)

    graph.invoke({"run_id": "r", "task_title": "t", "task_description": ""}, config=cfg)
    assert graph.get_state(cfg).next == ("apply_edits",)
    calls_after_first_plan = len([e for e in recorder.events if e[0] == "TOOL_CALL"])
    assert calls_after_first_plan > 0

    # Simulate the redirect rewind replan_run() performs.
    graph.update_state(cfg, {}, as_node="inspect_repository")
    assert graph.get_state(cfg).next == ("plan_change",)
    graph.invoke(None, config=cfg)

    assert graph.get_state(cfg).next == ("apply_edits",)
    calls_after_replan = len([e for e in recorder.events if e[0] == "TOOL_CALL"])
    assert calls_after_replan == calls_after_first_plan
