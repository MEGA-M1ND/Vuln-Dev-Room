"""Internal-only HTTP API.

Endpoints:
  GET  /health                        - liveness; leaks no secrets/model config
  POST /internal/runs                 - start a run (service-authenticated)
  GET  /internal/runs/{runId}         - agent-side state (service-authenticated)
  POST /internal/runs/{runId}/resume  - approve/reject the plan gate
  POST /internal/runs/{runId}/fork    - copy a source run's plan onto a new run
  POST /internal/runs/{runId}/review  - review a source run's plan/diff/tests

There is deliberately NO endpoint to run an arbitrary command or prompt.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status

from app.api.schemas import (
    CreateRunRequest,
    CreateRunResponse,
    ForkRunRequest,
    HealthResponse,
    ControlResponse,
    ResumeRunRequest,
    ResumeRunResponse,
    ReviewRunRequest,
    RunStateResponse,
)
from app.config import RepositoryConfig, Settings, get_settings
from app.graph.backend_agent import (
    RunRequest,
    fork_run,
    replan_run,
    resume_run,
    review_run,
    start_run,
)
from app.notifier import Notifier
from app.persistence import repositories as repositories_db
from app.persistence import runs as runs_db
from app.repository.clone import RepositorySourceError, github_https_url
from app.sandbox.docker_sandbox import ensure_docker_available
from app.sandbox.base import SandboxUnavailableError
from app.security.service_auth import require_service_token

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    settings = get_settings()
    docker_ok = True
    try:
        ensure_docker_available()
    except SandboxUnavailableError:
        docker_ok = False
    # Never reveal source paths, tokens, or keys — only counts/flags.
    return HealthResponse(
        status="ok",
        dockerAvailable=docker_ok,
        modelProvider=settings.model_provider,
        repositoryCount=len(settings.repositories),
    )


def _build_run_request(
    run: dict[str, Any],
    repo: RepositoryConfig,
    *,
    title: str,
    description: str | None,
    allowed_paths: list[str],
    pinned_revision: str | None = None,
) -> RunRequest:
    return RunRequest(
        run_id=run["id"],
        graph_thread_id=str(run["graphThreadId"]),
        task_title=title,
        task_description=description or "",
        repo_config=repo,
        allowed_paths=allowed_paths,
        pinned_revision=pinned_revision,
    )


def _resolve_repo(
    run: dict[str, Any], target_repository_key: str, settings: Settings
) -> RepositoryConfig | None:
    """Phase 1c: prefer the room's connected GitHub repository over the
    static demo registry, when the feature is enabled and a connection
    exists. Looked up directly from the same Postgres tables the web app
    writes — the run's roomId (already trusted, from the durable row) is the
    only input, never anything the caller passes about which repo to use.
    """
    if settings.real_repos_enabled:
        connection = repositories_db.get_active_repository_connection(str(run["roomId"]))
        if connection is not None:
            return RepositoryConfig(
                display_name=f"{connection.owner}/{connection.repo}",
                git_url=github_https_url(connection.owner, connection.repo),
                git_ref=connection.default_branch,
            )
    return settings.repository(target_repository_key)


def _fail_unknown_repository(run_id: str, summary: str) -> None:
    runs_db.update_run_status(
        run_id, "FAILED", error_code="UNKNOWN_REPOSITORY", error_summary=summary
    )
    runs_db.append_event(run_id, "RUN_FAILED", payload={"errorCode": "UNKNOWN_REPOSITORY"})


def _notifier_for(settings: Settings, run: dict[str, Any]) -> Notifier:
    return Notifier(settings=settings, run_id=run["id"], room_id=str(run["roomId"]))


def _execute_start(request: RunRequest, settings: Settings, notifier: Notifier) -> None:
    # Runs phase 1 in a background task; failures are recorded durably inside.
    start_run(request, settings, notifier=notifier)


def _execute_resume(request: RunRequest, settings: Settings, notifier: Notifier) -> None:
    resume_run(request, settings, notifier=notifier)


def _execute_replan(request: RunRequest, settings: Settings, notifier: Notifier) -> None:
    replan_run(request, settings, notifier=notifier)


@router.post(
    "/internal/runs",
    response_model=CreateRunResponse,
    dependencies=[Depends(require_service_token)],
)
def create_run(
    body: CreateRunRequest,
    background: BackgroundTasks,
    settings: Settings = Depends(get_settings),
) -> CreateRunResponse:
    # The durable AgentRun row is created by the Next.js server BEFORE calling
    # here; we look it up to resolve the graph thread id and repo config.
    run = runs_db.get_run(body.runId)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found.")

    try:
        repo = _resolve_repo(run, body.targetRepositoryKey, settings)
    except RepositorySourceError as exc:
        _fail_unknown_repository(body.runId, str(exc))
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    if repo is None:
        # Unknown repository key — reject and mark the run failed durably.
        _fail_unknown_repository(
            body.runId, f"Unknown repository key: {body.targetRepositoryKey!r}"
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unknown repository key.",
        )

    # Intersect the app-provided allow-list with the repository's own configured
    # allow-list (defense in depth): only paths allowed by BOTH are writable.
    allowed = _intersect_allowed(body.allowedPaths, repo.allowed_paths)

    run_request = _build_run_request(
        run,
        repo,
        title=body.title,
        description=body.description,
        allowed_paths=allowed,
    )
    background.add_task(
        _execute_start, run_request, settings, _notifier_for(settings, run)
    )
    return CreateRunResponse(runId=body.runId, status="RUNNING", accepted=True)


@router.post(
    "/internal/runs/{run_id}/resume",
    response_model=ResumeRunResponse,
    dependencies=[Depends(require_service_token)],
)
def resume_run_endpoint(
    run_id: str,
    body: ResumeRunRequest,
    background: BackgroundTasks,
    settings: Settings = Depends(get_settings),
) -> ResumeRunResponse:
    """Approve or reject a run paused at the plan-approval gate.

    Only valid while the run is AWAITING_APPROVAL. Approve resumes the graph
    (applying the checkpointed plan); reject is terminal and writes nothing.
    """
    run = runs_db.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found.")
    if run["status"] != "AWAITING_APPROVAL":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Run is not awaiting approval (status={run['status']}).",
        )

    notifier = _notifier_for(settings, run)

    if body.decision == "reject":
        # Nothing was written; the run ends here.
        runs_db.update_run_status(
            run_id,
            "CANCELLED",
            error_code="PLAN_REJECTED",
            error_summary="The plan was rejected by a room member.",
        )
        runs_db.append_event(run_id, "PLAN_REJECTED", actor_type="user")
        runs_db.append_event(run_id, "RUN_CANCELLED", actor_type="user")
        notifier.notify(status="CANCELLED", event_type="PLAN_REJECTED")
        return ResumeRunResponse(runId=run_id, status="CANCELLED", accepted=True)

    try:
        repo = _resolve_repo(run, str(run["targetRepositoryKey"]), settings)
    except RepositorySourceError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    if repo is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown repository key.")

    run_request = _build_run_request(
        run,
        repo,
        title="",  # title/description already captured in checkpoint state
        description="",
        allowed_paths=_intersect_allowed([], repo.allowed_paths),
        # Pinned to the exact commit the human approved, never wherever the
        # branch has since moved to.
        pinned_revision=run.get("baseRevision"),
    )
    background.add_task(_execute_resume, run_request, settings, notifier)
    return ResumeRunResponse(runId=run_id, status="RUNNING", accepted=True)


@router.post(
    "/internal/runs/{run_id}/cancel",
    response_model=ControlResponse,
    dependencies=[Depends(require_service_token)],
)
def cancel_run_endpoint(run_id: str) -> ControlResponse:
    """Acknowledge a cancellation request.

    The web app has already persisted `cancelRequestedAt`; the executing graph
    observes it at its next safe checkpoint and tears the sandbox down. A run
    that is not executing (queued but not started, or already finished) simply
    converges — this endpoint never forces a terminal status itself.
    """
    run = runs_db.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found.")
    return ControlResponse(runId=run_id, status=str(run["status"]), accepted=True)


@router.post(
    "/internal/runs/{run_id}/redirect",
    response_model=ControlResponse,
    dependencies=[Depends(require_service_token)],
)
def redirect_run_endpoint(
    run_id: str,
    background: BackgroundTasks,
    settings: Settings = Depends(get_settings),
) -> ControlResponse:
    """Pick up pending human guidance.

    A run parked at the approval gate is re-planned immediately here (the
    pending approval was already invalidated by the web app, so nothing else
    is using this checkpointed thread right now). A still-executing run picks
    the guidance up cooperatively at its own next safe checkpoint (Phase 3) —
    this endpoint must NOT also schedule a replan for it, or two background
    tasks would race to rewind the same LangGraph thread concurrently: the
    run's own in-flight `resume_run` invocation, and this one.
    """
    run = runs_db.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found.")

    current = str(run["status"])
    if current in ("SUCCEEDED", "FAILED", "CANCELLED"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Run has finished (status={current}).",
        )

    if current != "AWAITING_APPROVAL":
        # QUEUED/RUNNING: the guidance is already durably PENDING (the web app
        # persisted it before calling here). The active execution's own
        # steerable checkpoints will consume it — nothing to schedule.
        return ControlResponse(runId=run_id, status=current, accepted=True)

    try:
        repo = _resolve_repo(run, str(run["targetRepositoryKey"]), settings)
    except RepositorySourceError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    if repo is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown repository key.")

    run_request = _build_run_request(
        run,
        repo,
        title="",
        description="",
        allowed_paths=_intersect_allowed([], repo.allowed_paths),
        # replan_run never touches the sandbox (a guard toolset enforces
        # that), so this is unused there — kept for consistency with resume.
        pinned_revision=run.get("baseRevision"),
    )
    background.add_task(
        _execute_replan, run_request, settings, _notifier_for(settings, run)
    )
    return ControlResponse(runId=run_id, status="RUNNING", accepted=True)


@router.post(
    "/internal/runs/{run_id}/fork",
    response_model=ControlResponse,
    dependencies=[Depends(require_service_token)],
)
def fork_run_endpoint(
    run_id: str,
    body: ForkRunRequest,
    settings: Settings = Depends(get_settings),
) -> ControlResponse:
    """Fork (roadmap Phase 4): copy a source run's checkpointed plan onto
    this new run — already created by the web app on its own cloned task.

    Synchronous: unlike start/resume/replan this never touches Docker (the
    source is at the gate, so nothing has been written yet), so there is no
    need for a background task — the caller gets AWAITING_APPROVAL or a
    failure directly in the response.
    """
    run = runs_db.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found.")
    notifier = _notifier_for(settings, run)
    result_status = fork_run(run_id, body.sourceRunId, settings, notifier)
    return ControlResponse(
        runId=run_id, status=result_status, accepted=result_status == "AWAITING_APPROVAL"
    )


def _execute_review(run_id: str, source_run_id: str, settings: Settings, notifier: Notifier) -> None:
    review_run(run_id, source_run_id, settings, notifier=notifier)


@router.post(
    "/internal/runs/{run_id}/review",
    response_model=ControlResponse,
    dependencies=[Depends(require_service_token)],
)
def review_run_endpoint(
    run_id: str,
    body: ReviewRunRequest,
    background: BackgroundTasks,
    settings: Settings = Depends(get_settings),
) -> ControlResponse:
    """Reviewer-agent (roadmap Phase 5): review a source run's already-captured
    plan/diff/test-result — already created by the web app on the source
    run's own task.

    Backgrounded like start/resume/replan: it calls a Model, which may be
    network-bound for a real provider, so the caller gets QUEUED immediately
    and the room learns SUCCEEDED/FAILED via the usual notifier/polling path.
    """
    run = runs_db.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found.")
    notifier = _notifier_for(settings, run)
    background.add_task(_execute_review, run_id, body.sourceRunId, settings, notifier)
    return ControlResponse(runId=run_id, status="RUNNING", accepted=True)


@router.get(
    "/internal/runs/{run_id}",
    response_model=RunStateResponse,
    dependencies=[Depends(require_service_token)],
)
def get_run_state(run_id: str) -> RunStateResponse:
    run = runs_db.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found.")
    return RunStateResponse(
        runId=run["id"],
        status=run["status"],
        runVersion=run["runVersion"],
        agentId=run["agentId"],
        targetRepositoryKey=run["targetRepositoryKey"],
        baseRevision=run.get("baseRevision"),
        errorCode=run.get("errorCode"),
        errorSummary=run.get("errorSummary"),
    )


def _intersect_allowed(app_allowed: list[str], repo_allowed: list[str]) -> list[str]:
    if not app_allowed:
        return list(repo_allowed)
    if not repo_allowed:
        return []
    # Keep only globs the repository configuration also permits.
    repo_set = set(repo_allowed)
    intersected = [g for g in app_allowed if g in repo_set]
    return intersected or list(repo_allowed)
