"""Internal-only HTTP API.

Endpoints:
  GET  /health                        - liveness; leaks no secrets/model config
  POST /internal/runs                 - start a run (service-authenticated)
  GET  /internal/runs/{runId}         - agent-side state (service-authenticated)
  POST /internal/runs/{runId}/resume  - approve/reject the plan gate

There is deliberately NO endpoint to run an arbitrary command or prompt.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status

from app.api.schemas import (
    CreateRunRequest,
    CreateRunResponse,
    HealthResponse,
    ResumeRunRequest,
    ResumeRunResponse,
    RunStateResponse,
)
from app.config import RepositoryConfig, Settings, get_settings
from app.graph.backend_agent import RunRequest, resume_run, start_run
from app.notifier import Notifier
from app.persistence import runs as runs_db
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
) -> RunRequest:
    return RunRequest(
        run_id=run["id"],
        graph_thread_id=str(run["graphThreadId"]),
        ticket_title=title,
        ticket_description=description or "",
        repo_config=repo,
        allowed_paths=allowed_paths,
    )


def _notifier_for(settings: Settings, run: dict[str, Any]) -> Notifier:
    return Notifier(settings=settings, run_id=run["id"], room_id=str(run["roomId"]))


def _execute_start(request: RunRequest, settings: Settings, notifier: Notifier) -> None:
    # Runs phase 1 in a background task; failures are recorded durably inside.
    start_run(request, settings, notifier=notifier)


def _execute_resume(request: RunRequest, settings: Settings, notifier: Notifier) -> None:
    resume_run(request, settings, notifier=notifier)


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

    repo = settings.repository(body.targetRepositoryKey)
    if repo is None:
        # Unknown repository key — reject and mark the run failed durably.
        runs_db.update_run_status(
            body.runId,
            "FAILED",
            error_code="UNKNOWN_REPOSITORY",
            error_summary=f"Unknown repository key: {body.targetRepositoryKey!r}",
        )
        runs_db.append_event(
            body.runId,
            "RUN_FAILED",
            payload={"errorCode": "UNKNOWN_REPOSITORY"},
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unknown repository key.",
        )

    # Intersect the app-provided allow-list with the repository's own configured
    # allow-list (defense in depth): only paths allowed by BOTH are writable.
    allowed = _intersect_allowed(body.allowedPaths, repo.allowed_paths)

    run_request = _build_run_request(
        run, repo, title=body.title, description=body.description, allowed_paths=allowed
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

    repo = settings.repository(str(run["targetRepositoryKey"]))
    if repo is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown repository key.")

    run_request = _build_run_request(
        run,
        repo,
        title="",  # title/description already captured in checkpoint state
        description="",
        allowed_paths=_intersect_allowed([], repo.allowed_paths),
    )
    background.add_task(_execute_resume, run_request, settings, notifier)
    return ResumeRunResponse(runId=run_id, status="RUNNING", accepted=True)


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
