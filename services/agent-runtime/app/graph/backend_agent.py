"""The backend-agent LangGraph graph and its run orchestrator.

Pipeline (each step is a graph node, checkpointed):
    inspect_repository -> plan_change -> apply_edits -> run_tests
    -> capture_diff -> summarize

The orchestrator owns the sandbox lifecycle and the run's terminal status. Nodes
only transform serializable state and record durable artifacts/events through an
injected recorder, so the graph stays deterministic and testable.
"""

from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

logger = logging.getLogger(__name__)

from langgraph.graph import END, START, StateGraph

from app.config import RepositoryConfig, Settings
from app.graph.prompts import MAX_FILE_BYTES, MAX_PLANNING_TOOL_CALLS
from app.graph.state import AgentState
from app.models.base import Model, PlanRequest, ProposedEdit, ToolCall
from app.models.configured_model import build_model
from app.persistence import artifacts as artifacts_db
from app.persistence import runs as runs_db
from app.persistence.checkpoints import checkpointer_context, copy_thread
from app.sandbox.base import SandboxError, SandboxSetupError, SandboxUnavailableError
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
    """Writes events/artifacts to Postgres for a run and pings the realtime
    notifier so the room sees each event live."""

    run_id: str
    notifier: Any = None  # Notifier | NullNotifier | None

    def event(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        runs_db.append_event(self.run_id, event_type, payload=payload)
        if self.notifier is not None:
            self.notifier.notify(event_type=event_type)

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


class RunCancelled(Exception):
    """Raised at a safe checkpoint when a human has requested cancellation.

    Because it is only raised *between* graph nodes, work never stops mid-write.
    """


class RunRedirected(Exception):
    """Phase 3: raised at a safe checkpoint when guidance arrives while a node
    *downstream of the approval gate* is executing — not just while parked at
    the gate. `node` names where the run was interrupted, for the timeline.

    Like RunCancelled, only ever raised between graph nodes, so a redirect can
    abort in-flight work (e.g. mid apply_edits/run_tests) but never mid-write.
    """

    def __init__(self, node: str) -> None:
        self.node = node
        super().__init__(node)


@dataclass
class RunContext:
    toolset: Toolset
    model: Model
    language: str
    recorder: Recorder
    # Phase 1: cooperative cancellation probe. Returns True once a human has
    # asked the run to stop. Injected so tests can drive it deterministically.
    should_cancel: Callable[[], bool] = lambda: False
    # Phase 1: claims pending human guidance (redirects), marking it applied.
    take_redirects: Callable[[], list[dict[str, Any]]] = lambda: []
    # Phase 3: mid-run steering probe. True once guidance has arrived while a
    # node other than plan_change is executing. Only nodes downstream of the
    # approval gate check this — plan_change already consumes guidance itself
    # via take_redirects, and there is nothing to steer before it.
    has_pending_redirect: Callable[[], bool] = lambda: False


def _checkpoint(ctx: RunContext, *, node: str = "", steerable: bool = False) -> None:
    """Safe checkpoint, called at the start of every graph node.

    Cancellation is always observed here. Phase 3: nodes downstream of the
    approval gate also observe guidance that arrived while they were running
    (`steerable=True`), so a human can steer an *active* run — not only
    redirect one waiting at the gate. Both are cooperative: raised only
    between graph nodes, so a run in flight aborts cleanly, never mid-write.
    """
    if ctx.should_cancel():
        raise RunCancelled()
    if steerable and ctx.has_pending_redirect():
        raise RunRedirected(node)


def _build_graph(ctx: RunContext, checkpointer: Any) -> Any:
    def inspect_repository(state: AgentState) -> dict[str, Any]:
        _checkpoint(ctx)
        tree = ctx.toolset.list_repository()
        ctx.recorder.event("REPOSITORY_INSPECTED", {"fileCount": len(tree)})
        return {"repo_tree": tree}

    def _execute_tool_call(call: ToolCall) -> str:
        """Run one exploration tool call against the sandbox toolset.

        Reads are permitted anywhere in the workspace (traversal is still
        blocked by path normalization) — this mirrors `Toolset.read_file`,
        which is deliberately not allow-list-gated the way `apply_patch` is.
        """
        try:
            if call.tool == "list_repository":
                return "\n".join(ctx.toolset.list_repository())
            if call.tool == "read_file":
                content = ctx.toolset.read_file(call.args.get("path", ""))
                return content[:MAX_FILE_BYTES]
            if call.tool == "search_repository":
                results = ctx.toolset.search_repository(call.args.get("query", ""))
                return "\n".join(results)
            return f"ERROR: unknown tool {call.tool!r}"
        except SandboxError as exc:
            return f"ERROR: {exc}"

    def _explore_repository(
        request: PlanRequest,
    ) -> tuple[dict[str, str], int]:
        """Bounded agentic loop: the model may request up to
        MAX_PLANNING_TOOL_CALLS read-only tool calls before planning.

        Returns the accumulated file excerpts and how many calls were made.
        Models that don't implement exploration (the default `next_tool_call`
        returns None immediately) fall straight through with zero calls,
        exactly as before this loop existed.
        """
        excerpts = dict(request.file_excerpts)
        history: list[tuple[ToolCall, str]] = []
        for _ in range(MAX_PLANNING_TOOL_CALLS):
            call = ctx.model.next_tool_call(
                PlanRequest(
                    title=request.title,
                    description=request.description,
                    language=request.language,
                    repo_tree=request.repo_tree,
                    file_excerpts=excerpts,
                ),
                history,
            )
            if call is None:
                break
            result = _execute_tool_call(call)
            history.append((call, result))
            if call.tool == "read_file" and call.args.get("path"):
                excerpts[call.args["path"]] = result
            ctx.recorder.event("TOOL_CALL", {"tool": call.tool, "args": call.args})
        if history:
            ctx.recorder.event("REPO_EXPLORATION_FINISHED", {"toolCalls": len(history)})
        return excerpts, len(history)

    def plan_change(state: AgentState) -> dict[str, Any]:
        _checkpoint(ctx)

        # Phase 1: fold in any human guidance recorded since the last plan.
        # Claiming here marks it APPLIED, so guidance is consumed exactly once.
        applied = ctx.take_redirects()
        guidance = [
            str(item.get("guidance") or "").strip()
            for item in applied
            if str(item.get("guidance") or "").strip()
        ]
        prior_guidance: list[str] = list(state.get("guidance", []))
        all_guidance = prior_guidance + guidance
        for item in applied:
            ctx.recorder.event(
                "REDIRECT_APPLIED",
                {"interventionId": item.get("id"), "authorUserId": item.get("authorUserId")},
            )

        description = state.get("ticket_description", "") or ""
        if all_guidance:
            # Human guidance is appended as explicit, attributed instructions.
            description = (
                description
                + "\n\nAdditional guidance from the team:\n"
                + "\n".join(f"- {g}" for g in all_guidance)
            )

        excerpts = dict(state.get("excerpts", {}))
        # Phase 1b: explore only the first time this run plans. A re-plan
        # (after a redirect at the approval gate) runs against a sandbox that
        # refuses every operation by design — planning there must be a pure
        # model call over the excerpts already gathered, never a fresh
        # exploration. `exploration_done` is checkpointed state, so it survives
        # the rewind that `replan_run` performs.
        if not state.get("exploration_done", False):
            excerpts, _ = _explore_repository(
                PlanRequest(
                    title=state.get("ticket_title", ""),
                    description=description,
                    language=ctx.language,
                    repo_tree=state.get("repo_tree", []),
                    file_excerpts=excerpts,
                )
            )

        result = ctx.model.propose_change(
            PlanRequest(
                title=state.get("ticket_title", ""),
                description=description,
                language=ctx.language,
                repo_tree=state.get("repo_tree", []),
                file_excerpts=excerpts,
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
            "guidance": all_guidance,
            "excerpts": excerpts,
            "exploration_done": True,
        }

    def apply_edits(state: AgentState) -> dict[str, Any]:
        # This node is the first that can write. It only ever runs after the
        # human approval gate (interrupt_before) has been passed.
        _checkpoint(ctx, node="apply_edits", steerable=True)
        ctx.recorder.event(
            "EDITS_STARTED",
            {"fileCount": len(state.get("proposed_edits", []))},
        )
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
        _checkpoint(ctx, node="run_tests", steerable=True)
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
        _checkpoint(ctx, node="capture_diff", steerable=True)
        diff = ctx.toolset.get_git_diff()
        # Alongside the human-readable diff, record the exact reviewed content
        # of each changed file. Delivery (Phase 3) applies THIS, so a pull
        # request always carries precisely what a human approved — never a
        # reconstruction of the diff or an arbitrary later workspace state.
        applied_paths = state.get("applied_paths", [])
        by_path = {
            edit["path"]: edit["new_content"]
            for edit in state.get("proposed_edits", [])
        }
        reviewed_files = [
            {"path": path, "content": by_path[path]}
            for path in applied_paths
            if path in by_path
        ]
        ctx.recorder.artifact(
            "DIFF",
            "Unified diff",
            content_text=diff,
            content_json={"files": reviewed_files},
            metadata_json={"changedFiles": applied_paths},
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

    # Stage 3: pause AFTER planning and BEFORE any file is written, so a human
    # can approve or reject the plan. The proposed edits are already in the
    # checkpointed state, so resuming applies exactly the approved plan.
    return graph.compile(checkpointer=checkpointer, interrupt_before=["apply_edits"])


# --- orchestrator -----------------------------------------------------------


@dataclass
class RunRequest:
    run_id: str
    graph_thread_id: str
    ticket_title: str
    ticket_description: str
    repo_config: RepositoryConfig
    allowed_paths: list[str]
    # Phase 1c: for a connected-repo run, the exact commit a human already
    # planned/approved against. Set on resume so the fresh sandbox reflects
    # precisely that commit, never wherever the branch has since moved to.
    # None on the initial run (there is nothing to pin to yet) and always
    # None for the static demo registry, which has no notion of a moving ref.
    pinned_revision: str | None = None


def _thread_config(request: RunRequest) -> dict[str, Any]:
    return {"configurable": {"thread_id": request.graph_thread_id}}


def _resolve_repository(
    repo_config: RepositoryConfig, pinned_revision: str | None, settings: Settings
) -> tuple[RepositoryConfig, Callable[[], None]]:
    """Turn a RunRequest's RepositoryConfig into one with a real local
    `source_path`, plus a cleanup callable the caller must run once done with
    the sandbox.

    The static demo registry (`source_path` already set) passes through
    unchanged — a no-op, byte-for-byte the behavior before Phase 1c existed.
    A connected repo (`git_url` set) is cloned onto the runtime host — which
    has network, unlike the agent sandbox — and its language/test command are
    detected from the resulting tree.
    """
    if repo_config.source_path:
        return repo_config, lambda: None

    assert repo_config.git_url is not None  # enforced by RepositoryConfig's validator
    cloned = clone_repository(
        repo_config.git_url,
        ref=repo_config.git_ref,
        pinned_sha=pinned_revision,
        timeout=settings.clone_timeout,
    )
    tree = list_tracked_files(cloned.path)
    language, test_command = detect_language_and_test_command(tree)
    effective = RepositoryConfig(
        display_name=repo_config.display_name,
        source_path=cloned.path,
        allowed_paths=repo_config.allowed_paths or ["**"],
        test_command=test_command,
        language=language,
    )

    def cleanup() -> None:
        shutil.rmtree(cloned.path, ignore_errors=True)

    return effective, cleanup


def start_run(request: RunRequest, settings: Settings, notifier: Any = None) -> str:
    """Phase 1: inspect + plan, then pause at the approval gate.

    Returns "AWAITING_APPROVAL" when a human decision is required, or a terminal
    status when there is nothing to approve (no edits) or on failure.
    """
    recorder = DbRecorder(request.run_id, notifier=notifier)
    runs_db.update_run_status(request.run_id, "RUNNING")
    _notify(notifier, status="RUNNING")

    try:
        ensure_docker_available()
    except SandboxUnavailableError as exc:
        return _fail(request.run_id, recorder, "SANDBOX_UNAVAILABLE", str(exc), notifier)

    sandbox = DockerSandbox(settings)
    cleanup_source: Callable[[], None] = lambda: None
    try:
        effective_repo, cleanup_source = _resolve_repository(
            request.repo_config, None, settings
        )
        prepared = sandbox.prepare_repository(effective_repo.source_path)
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
        _record_setup(recorder, prepared)

        toolset = Toolset(
            sandbox=sandbox,
            allowed_paths=request.allowed_paths or effective_repo.allowed_paths,
            test_command=effective_repo.test_command,
        )
        ctx = RunContext(
            toolset=toolset,
            model=build_model(settings),
            language=effective_repo.language,
            recorder=recorder,
            should_cancel=lambda: runs_db.get_cancel_requested(request.run_id),
            take_redirects=lambda: runs_db.take_pending_redirects(request.run_id),
            has_pending_redirect=lambda: runs_db.has_pending_redirect(request.run_id),
        )

        with checkpointer_context() as checkpointer:
            app = _build_graph(ctx, checkpointer)
            cfg = _thread_config(request)
            # Runs inspect_repository + plan_change, then stops before apply_edits.
            app.invoke(
                {
                    "run_id": request.run_id,
                    "ticket_title": request.ticket_title,
                    "ticket_description": request.ticket_description,
                    "language": effective_repo.language,
                    "allowed_paths": toolset.allowed_paths,
                },
                config=cfg,
            )
            state = app.get_state(cfg)
            proposed = state.values.get("proposed_edits", [])

            if not proposed:
                # Nothing to approve — continue straight to completion.
                final_state = app.invoke(None, config=cfg)
                return _finalize(request.run_id, recorder, final_state, notifier)

        # Pause for human approval. The plan artifact is already recorded.
        runs_db.update_run_status(request.run_id, "AWAITING_APPROVAL")
        recorder.event(
            "APPROVAL_REQUESTED",
            {"proposedFiles": [e["path"] for e in proposed]},
        )
        _notify(notifier, status="AWAITING_APPROVAL")
        return "AWAITING_APPROVAL"

    except RunCancelled:
        return _cancelled(request.run_id, recorder, notifier)
    except PathNotAllowedError as exc:
        return _fail(request.run_id, recorder, "PATH_NOT_ALLOWED", str(exc), notifier)
    except SandboxUnavailableError as exc:
        return _fail(request.run_id, recorder, "SANDBOX_UNAVAILABLE", str(exc), notifier)
    except RepositorySourceError as exc:
        return _fail(request.run_id, recorder, "CLONE_FAILED", str(exc), notifier)
    except UnsupportedRepositoryError as exc:
        return _fail(request.run_id, recorder, "UNSUPPORTED_REPOSITORY", str(exc), notifier)
    except SandboxSetupError as exc:
        return _fail(request.run_id, recorder, "SETUP_FAILED", str(exc), notifier)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Run %s failed unexpectedly", request.run_id)
        return _fail(request.run_id, recorder, "AGENT_ERROR", f"{type(exc).__name__}: {exc}", notifier)
    finally:
        sandbox.cleanup()
        cleanup_source()


def resume_run(request: RunRequest, settings: Settings, notifier: Any = None) -> str:
    """Phase 2 (approval): apply the checkpointed plan in a fresh sandbox, then
    run tests, capture the diff and summarize.

    A fresh sandbox at the same base revision is prepared, and the graph resumes
    from the checkpoint applying exactly the plan the human approved.
    """
    recorder = DbRecorder(request.run_id, notifier=notifier)
    runs_db.update_run_status(request.run_id, "RUNNING")
    recorder.event("PLAN_APPROVED", {})
    _notify(notifier, status="RUNNING")

    try:
        ensure_docker_available()
    except SandboxUnavailableError as exc:
        return _fail(request.run_id, recorder, "SANDBOX_UNAVAILABLE", str(exc), notifier)

    sandbox = DockerSandbox(settings)
    cleanup_source: Callable[[], None] = lambda: None
    try:
        # Pinned to the exact commit the human already planned/approved
        # against (a no-op for the static registry, which has no moving ref).
        effective_repo, cleanup_source = _resolve_repository(
            request.repo_config, request.pinned_revision, settings
        )
        prepared = sandbox.prepare_repository(effective_repo.source_path)
        runs_db.update_run_status(request.run_id, "RUNNING", sandbox_id=sandbox.sandbox_id)
        _record_setup(recorder, prepared)

        toolset = Toolset(
            sandbox=sandbox,
            allowed_paths=request.allowed_paths or effective_repo.allowed_paths,
            test_command=effective_repo.test_command,
        )
        ctx = RunContext(
            toolset=toolset,
            model=build_model(settings),
            language=effective_repo.language,
            recorder=recorder,
            should_cancel=lambda: runs_db.get_cancel_requested(request.run_id),
            take_redirects=lambda: runs_db.take_pending_redirects(request.run_id),
            has_pending_redirect=lambda: runs_db.has_pending_redirect(request.run_id),
        )
        _ = prepared  # base revision unchanged; kept for clarity

        with checkpointer_context() as checkpointer:
            app = _build_graph(ctx, checkpointer)
            cfg = _thread_config(request)
            # Resume from the interrupt: applies checkpointed proposed_edits.
            final_state = app.invoke(None, config=cfg)

        return _finalize(request.run_id, recorder, final_state, notifier)

    except RunCancelled:
        return _cancelled(request.run_id, recorder, notifier)
    except RunRedirected as exc:
        # Phase 3: guidance arrived while this run was actively applying
        # edits/running tests/capturing the diff — abandon this attempt
        # (its sandbox is discarded in `finally`, same as a cancellation)
        # and re-plan with the new guidance. `replan_run` rewinds the SAME
        # checkpointed thread to just before plan_change and stops again at
        # the approval gate — the gate is never skipped on a re-plan, so a
        # steered run can't have a stale plan applied out from under it.
        recorder.event("RUN_STEERED", {"interruptedAt": exc.node})
        return replan_run(request, settings, notifier)
    except PathNotAllowedError as exc:
        return _fail(request.run_id, recorder, "PATH_NOT_ALLOWED", str(exc), notifier)
    except SandboxUnavailableError as exc:
        return _fail(request.run_id, recorder, "SANDBOX_UNAVAILABLE", str(exc), notifier)
    except RepositorySourceError as exc:
        return _fail(request.run_id, recorder, "CLONE_FAILED", str(exc), notifier)
    except UnsupportedRepositoryError as exc:
        return _fail(request.run_id, recorder, "UNSUPPORTED_REPOSITORY", str(exc), notifier)
    except SandboxSetupError as exc:
        return _fail(request.run_id, recorder, "SETUP_FAILED", str(exc), notifier)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Run %s failed unexpectedly", request.run_id)
        return _fail(request.run_id, recorder, "AGENT_ERROR", f"{type(exc).__name__}: {exc}", notifier)
    finally:
        sandbox.cleanup()
        cleanup_source()


def _finalize(
    run_id: str, recorder: Recorder, final_state: AgentState, notifier: Any
) -> str:
    applied = final_state.get("applied_paths", [])
    passed = final_state.get("tests_passed", False)
    if applied and not passed:
        return _fail(
            run_id,
            recorder,
            "TESTS_FAILED",
            "The change was applied but the project test suite did not pass.",
            notifier,
        )
    runs_db.update_run_status(run_id, "SUCCEEDED")
    recorder.event("RUN_SUCCEEDED", {"changedFiles": applied})
    _notify(notifier, status="SUCCEEDED")
    return "SUCCEEDED"


def _notify(notifier: Any, *, status: str) -> None:
    if notifier is not None:
        notifier.notify(status=status)


def _record_setup(recorder: Recorder, prepared: Any) -> None:
    """Surface the setup phase in the run's activity timeline. A no-op for the
    common case (no manifest, no setup phase — dependencies_installed is
    False for both today's demo fixture and any repo with no third-party
    dependencies)."""
    if not prepared.dependencies_installed:
        return
    recorder.artifact(
        "LOG",
        "Dependency installation",
        content_text=prepared.setup_output,
    )
    recorder.event(
        "DEPENDENCIES_INSTALLED",
        {"outputBytes": len(prepared.setup_output)},
    )


def _cancelled(run_id: str, recorder: Recorder, notifier: Any = None) -> str:
    """Terminal transition for a cooperatively cancelled run.

    Reached only from a safe checkpoint between graph nodes, so no write was in
    flight. The caller's `finally` tears the sandbox down.
    """
    runs_db.update_run_status(
        run_id,
        "CANCELLED",
        error_code="CANCELLED_BY_USER",
        error_summary="Cancelled by a room member; the sandbox was destroyed.",
    )
    recorder.event("RUN_CANCELLED", {"cooperative": True})
    if notifier is not None:
        notifier.notify(status="CANCELLED")
    return "CANCELLED"


def replan_run(request: RunRequest, settings: Settings, notifier: Any = None) -> str:
    """Re-plan a run that was parked at the approval gate when guidance arrived.

    Rewinds the checkpointed graph to just before `plan_change`, so invoking it
    re-runs planning with the new guidance and stops again at the approval gate.
    The previously proposed edits are replaced, which is exactly why a redirect
    invalidates a pending approval: stale instructions can never be applied.

    Planning is a pure model call over already-captured excerpts, so no sandbox
    is needed. A guard sandbox makes that invariant explicit and fails loudly if
    a node ever tries to touch the repository here.
    """
    recorder = DbRecorder(request.run_id, notifier=notifier)
    try:
        if runs_db.get_cancel_requested(request.run_id):
            return _cancelled(request.run_id, recorder, notifier)

        toolset = Toolset(
            sandbox=_GuardSandbox(),
            allowed_paths=request.allowed_paths or request.repo_config.allowed_paths,
            test_command=request.repo_config.test_command,
        )
        ctx = RunContext(
            toolset=toolset,
            model=build_model(settings),
            language=request.repo_config.language,
            recorder=recorder,
            should_cancel=lambda: runs_db.get_cancel_requested(request.run_id),
            take_redirects=lambda: runs_db.take_pending_redirects(request.run_id),
            has_pending_redirect=lambda: runs_db.has_pending_redirect(request.run_id),
        )

        with checkpointer_context() as checkpointer:
            app = _build_graph(ctx, checkpointer)
            cfg = _thread_config(request)
            # Rewind: presenting the state "as" inspect_repository makes
            # plan_change the next node to run.
            app.update_state(cfg, {}, as_node="inspect_repository")
            app.invoke(None, config=cfg)
            state = app.get_state(cfg)
            proposed = state.values.get("proposed_edits", [])

        if not proposed:
            runs_db.update_run_status(
                request.run_id,
                "FAILED",
                error_code="NO_ACTIONABLE_PLAN",
                error_summary="After the redirect the agent proposed no changes.",
            )
            recorder.event("RUN_FAILED", {"errorCode": "NO_ACTIONABLE_PLAN"})
            _notify(notifier, status="FAILED")
            return "FAILED"

        # Back to the gate: the new plan needs fresh human approval.
        runs_db.update_run_status(request.run_id, "AWAITING_APPROVAL")
        recorder.event(
            "APPROVAL_REQUESTED",
            {"proposedFiles": [e["path"] for e in proposed], "afterRedirect": True},
        )
        _notify(notifier, status="AWAITING_APPROVAL")
        return "AWAITING_APPROVAL"

    except RunCancelled:
        return _cancelled(request.run_id, recorder, notifier)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Run %s failed unexpectedly", request.run_id)
        return _fail(
            request.run_id, recorder, "AGENT_ERROR", f"{type(exc).__name__}: {exc}", notifier
        )


def fork_run(
    run_id: str, source_run_id: str, settings: Settings, notifier: Any = None
) -> str:
    """Fork (roadmap Phase 4): branch a run parked at the approval gate.

    Copies the source run's checkpointed thread onto this run's own thread
    (already created by the web app, on its own cloned ticket — see
    `docs/ROADMAP.md`), so the fork starts `AWAITING_APPROVAL` with exactly
    the plan the source had at the moment of forking, free to be approved,
    rejected, or redirected independently from there.

    Only a source parked at the gate is forkable: no sandbox is needed here
    (nothing has been written yet — the interrupt precedes `apply_edits` — so
    there is nothing to prepare until someone acts on the fork itself), and
    unlike start/resume/replan this never touches Docker, so it is fast
    enough to run synchronously rather than as a background task.
    """
    recorder = DbRecorder(run_id, notifier=notifier)
    source = runs_db.get_run(source_run_id)
    if source is None or str(source["status"]) != "AWAITING_APPROVAL":
        return _fail(
            run_id,
            recorder,
            "FORK_SOURCE_NOT_FORKABLE",
            "Only a run waiting for approval can be forked.",
            notifier,
        )
    run = runs_db.get_run(run_id)
    if run is None:
        return _fail(run_id, recorder, "AGENT_ERROR", "The new run row does not exist.", notifier)

    try:
        copied = copy_thread(str(source["graphThreadId"]), str(run["graphThreadId"]))
        if copied == 0:
            return _fail(
                run_id,
                recorder,
                "FORK_SOURCE_NOT_FORKABLE",
                "The source run has no checkpointed plan to fork.",
                notifier,
            )

        with checkpointer_context() as checkpointer:
            tuple_ = checkpointer.get_tuple(
                {"configurable": {"thread_id": str(run["graphThreadId"]), "checkpoint_ns": ""}}
            )
        values = (tuple_.checkpoint.get("channel_values", {}) if tuple_ else {}) or {}
        proposed = values.get("proposed_edits", [])

        runs_db.update_run_status(
            run_id, "AWAITING_APPROVAL", base_revision=source.get("baseRevision")
        )
        recorder.event(
            "APPROVAL_REQUESTED",
            {"proposedFiles": [e["path"] for e in proposed], "forkedFrom": source_run_id},
        )
        _notify(notifier, status="AWAITING_APPROVAL")
        return "AWAITING_APPROVAL"
    except Exception as exc:  # noqa: BLE001
        logger.exception("Fork %s failed unexpectedly", run_id)
        return _fail(run_id, recorder, "AGENT_ERROR", f"{type(exc).__name__}: {exc}", notifier)


class _GuardSandbox:
    """A sandbox that refuses every operation.

    Used on the re-plan path to enforce "planning must not touch the repository".
    If a future node breaks that assumption, this fails loudly instead of
    silently operating on an unprepared workspace.
    """

    sandbox_id = "guard"

    def _refuse(self, *_args: Any, **_kwargs: Any) -> Any:
        raise SandboxError(
            "The re-planning phase must not access the repository sandbox."
        )

    list_tree = _refuse
    read_file = _refuse
    search_repository = _refuse
    apply_patch = _refuse
    run_tests = _refuse
    get_git_diff = _refuse
    get_git_status = _refuse
    collect_logs = _refuse
    prepare_repository = _refuse

    def cleanup(self) -> None:
        return


def _fail(
    run_id: str, recorder: Recorder, code: str, summary: str, notifier: Any = None
) -> str:
    from app.security.redaction import redact

    safe = redact(summary)
    runs_db.update_run_status(run_id, "FAILED", error_code=code, error_summary=safe)
    recorder.event("RUN_FAILED", {"errorCode": code, "errorSummary": safe})
    if notifier is not None:
        notifier.notify(status="FAILED")
    return "FAILED"
