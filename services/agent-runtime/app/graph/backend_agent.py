"""The backend-agent LangGraph graph and its run orchestrator.

Pipeline (each step is a graph node, checkpointed):
    inspect_repository -> plan_change -> apply_edits -> run_tests
    -> capture_diff -> summarize

The orchestrator owns the sandbox lifecycle and the run's terminal status. Nodes
only transform serializable state and record durable artifacts/events through an
injected recorder, so the graph stays deterministic and testable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from langgraph.graph import END, START, StateGraph

from app.config import RepositoryConfig, Settings
from app.graph.prompts import MAX_FILE_BYTES, MAX_INSPECTED_FILES
from app.graph.state import AgentState
from app.models.base import Model, PlanRequest, ProposedEdit
from app.models.configured_model import build_model
from app.persistence import artifacts as artifacts_db
from app.persistence import runs as runs_db
from app.persistence.checkpoints import checkpointer_context
from app.sandbox.base import SandboxError, SandboxUnavailableError
from app.sandbox.docker_sandbox import DockerSandbox, ensure_docker_available
from app.security.paths import PathNotAllowedError
from app.tools.repository import Toolset


# --- recorder ---------------------------------------------------------------


class Recorder(Protocol):
    def event(self, event_type: str, payload: dict[str, Any] | None = None) -> None: ...
    def artifact(
        self,
        artifact_type: str,
        title: str,
        *,
        content_text: str | None = None,
        content_json: Any = None,
        metadata_json: dict[str, Any] | None = None,
    ) -> None: ...


@dataclass
class DbRecorder:
    """Writes events/artifacts to Postgres for a run."""

    run_id: str

    def event(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        runs_db.append_event(self.run_id, event_type, payload=payload)

    def artifact(
        self,
        artifact_type: str,
        title: str,
        *,
        content_text: str | None = None,
        content_json: Any = None,
        metadata_json: dict[str, Any] | None = None,
    ) -> None:
        artifacts_db.append_artifact(
            self.run_id,
            artifact_type,
            title,
            content_text=content_text,
            content_json=content_json,
            metadata_json=metadata_json,
        )


@dataclass
class CollectingRecorder:
    """In-memory recorder for tests: captures events/artifacts, no DB."""

    events: list[tuple[str, dict[str, Any] | None]] = field(default_factory=list)
    artifacts: list[dict[str, Any]] = field(default_factory=list)

    def event(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        self.events.append((event_type, payload))

    def artifact(self, artifact_type: str, title: str, **kwargs: Any) -> None:
        self.artifacts.append({"type": artifact_type, "title": title, **kwargs})


# --- run context + nodes ----------------------------------------------------


@dataclass
class RunContext:
    toolset: Toolset
    model: Model
    language: str
    recorder: Recorder


def _build_graph(ctx: RunContext, checkpointer: Any) -> Any:
    def inspect_repository(state: AgentState) -> dict[str, Any]:
        tree = ctx.toolset.list_repository()
        excerpts: dict[str, str] = {}
        for path in tree:
            if len(excerpts) >= MAX_INSPECTED_FILES:
                break
            if not path.endswith(".py"):
                continue
            if not ctx.toolset.is_allowed(path):
                continue
            try:
                content = ctx.toolset.read_file(path)
            except SandboxError:
                continue
            excerpts[path] = content[:MAX_FILE_BYTES]
        ctx.recorder.event(
            "REPOSITORY_INSPECTED",
            {"fileCount": len(tree), "inspected": list(excerpts.keys())},
        )
        return {"repo_tree": tree, "excerpts": excerpts}

    def plan_change(state: AgentState) -> dict[str, Any]:
        result = ctx.model.propose_change(
            PlanRequest(
                title=state.get("ticket_title", ""),
                description=state.get("ticket_description", "") or "",
                language=ctx.language,
                repo_tree=state.get("repo_tree", []),
                file_excerpts=state.get("excerpts", {}),
            )
        )
        edits = [
            {"path": e.path, "new_content": e.new_content, "rationale": e.rationale}
            for e in result.edits
        ]
        ctx.recorder.artifact(
            "PLAN",
            "Implementation plan",
            content_text=result.plan_text,
            metadata_json={"proposedFiles": [e["path"] for e in edits]},
        )
        ctx.recorder.event("PLAN_CREATED", {"proposedFiles": [e["path"] for e in edits]})
        return {
            "plan_text": result.plan_text,
            "proposed_edits": edits,
            "summary_text": result.summary_hint,
        }

    def apply_edits(state: AgentState) -> dict[str, Any]:
        applied: list[str] = []
        for edit in state.get("proposed_edits", []):
            # Allow-list enforced inside apply_patch; a violation fails the run.
            result = ctx.toolset.apply_patch(edit["path"], edit["new_content"])
            applied.append(result.path)
            ctx.recorder.event(
                "FILE_PATCHED", {"path": result.path, "created": result.created}
            )
        return {"applied_paths": applied}

    def run_tests(state: AgentState) -> dict[str, Any]:
        ctx.recorder.event("TESTS_STARTED", {"command": ctx.toolset.test_command})
        outcome = ctx.toolset.run_project_tests()
        ctx.recorder.artifact(
            "TEST_RESULT",
            "Test results",
            content_text=outcome.output,
            metadata_json={
                "passed": outcome.passed,
                "exitCode": outcome.exit_code,
                "timedOut": outcome.timed_out,
                "command": ctx.toolset.test_command,
            },
        )
        ctx.recorder.event(
            "TESTS_FINISHED",
            {"passed": outcome.passed, "exitCode": outcome.exit_code},
        )
        return {
            "tests_passed": outcome.passed,
            "tests_output": outcome.output,
            "tests_exit_code": outcome.exit_code,
        }

    def capture_diff(state: AgentState) -> dict[str, Any]:
        diff = ctx.toolset.get_git_diff()
        ctx.recorder.artifact(
            "DIFF",
            "Unified diff",
            content_text=diff,
            metadata_json={"changedFiles": state.get("applied_paths", [])},
        )
        ctx.recorder.event("DIFF_CAPTURED", {"bytes": len(diff)})
        return {"diff_text": diff}

    def summarize(state: AgentState) -> dict[str, Any]:
        applied = state.get("applied_paths", [])
        passed = state.get("tests_passed", False)
        base = state.get("summary_text") or ""
        verdict = (
            "All tests passed."
            if passed
            else "Tests did not pass after the change."
            if applied
            else "No changes were required."
        )
        summary = (base + "\n\n" + verdict).strip() if base else verdict
        ctx.recorder.artifact("SUMMARY", "Implementation summary", content_text=summary)
        return {"summary_text": summary}

    graph = StateGraph(AgentState)
    graph.add_node("inspect_repository", inspect_repository)
    graph.add_node("plan_change", plan_change)
    graph.add_node("apply_edits", apply_edits)
    graph.add_node("run_tests", run_tests)
    graph.add_node("capture_diff", capture_diff)
    graph.add_node("summarize", summarize)

    graph.add_edge(START, "inspect_repository")
    graph.add_edge("inspect_repository", "plan_change")
    graph.add_edge("plan_change", "apply_edits")
    graph.add_edge("apply_edits", "run_tests")
    graph.add_edge("run_tests", "capture_diff")
    graph.add_edge("capture_diff", "summarize")
    graph.add_edge("summarize", END)

    return graph.compile(checkpointer=checkpointer)


# --- orchestrator -----------------------------------------------------------


@dataclass
class RunRequest:
    run_id: str
    graph_thread_id: str
    ticket_title: str
    ticket_description: str
    repo_config: RepositoryConfig
    allowed_paths: list[str]


def run_backend_agent(request: RunRequest, settings: Settings) -> str:
    """Execute a run to completion. Returns the terminal status.

    Owns sandbox lifecycle + terminal status. Never raises to the caller: all
    failures are recorded durably as FAILED with an error code.
    """
    recorder: Recorder = DbRecorder(request.run_id)
    runs_db.update_run_status(request.run_id, "RUNNING")

    # 1. Sandbox must be a real isolated container — no host fallback.
    try:
        ensure_docker_available()
    except SandboxUnavailableError as exc:
        return _fail(request.run_id, recorder, "SANDBOX_UNAVAILABLE", str(exc))

    sandbox = DockerSandbox(settings)
    try:
        prepared = sandbox.prepare_repository(request.repo_config.source_path)
        runs_db.update_run_status(
            request.run_id,
            "RUNNING",
            sandbox_id=sandbox.sandbox_id,
            base_revision=prepared.base_revision,
        )
        recorder.event(
            "SANDBOX_PREPARED",
            {"baseRevision": prepared.base_revision, "fileCount": len(prepared.tree)},
        )

        toolset = Toolset(
            sandbox=sandbox,
            allowed_paths=request.allowed_paths or request.repo_config.allowed_paths,
            test_command=request.repo_config.test_command,
        )
        model = build_model(settings)
        ctx = RunContext(
            toolset=toolset, model=model, language=request.repo_config.language, recorder=recorder
        )

        with checkpointer_context() as checkpointer:
            app = _build_graph(ctx, checkpointer)
            final_state: AgentState = app.invoke(
                {
                    "run_id": request.run_id,
                    "ticket_title": request.ticket_title,
                    "ticket_description": request.ticket_description,
                    "language": request.repo_config.language,
                    "allowed_paths": toolset.allowed_paths,
                },
                config={"configurable": {"thread_id": request.graph_thread_id}},
            )

        applied = final_state.get("applied_paths", [])
        passed = final_state.get("tests_passed", False)
        if applied and not passed:
            return _fail(
                request.run_id,
                recorder,
                "TESTS_FAILED",
                "The change was applied but the project test suite did not pass.",
            )
        runs_db.update_run_status(request.run_id, "SUCCEEDED")
        recorder.event("RUN_SUCCEEDED", {"changedFiles": applied})
        return "SUCCEEDED"

    except PathNotAllowedError as exc:
        return _fail(request.run_id, recorder, "PATH_NOT_ALLOWED", str(exc))
    except SandboxUnavailableError as exc:
        return _fail(request.run_id, recorder, "SANDBOX_UNAVAILABLE", str(exc))
    except Exception as exc:  # noqa: BLE001 - record any failure durably
        return _fail(request.run_id, recorder, "AGENT_ERROR", f"{type(exc).__name__}: {exc}")
    finally:
        sandbox.cleanup()


def _fail(run_id: str, recorder: Recorder, code: str, summary: str) -> str:
    from app.security.redaction import redact

    safe = redact(summary)
    runs_db.update_run_status(run_id, "FAILED", error_code=code, error_summary=safe)
    recorder.event("RUN_FAILED", {"errorCode": code, "errorSummary": safe})
    return "FAILED"
