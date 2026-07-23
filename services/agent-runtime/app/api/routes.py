"""Internal-only HTTP API.

Endpoints:
  GET  /health                 - liveness; leaks no secrets/model config
  POST /internal/runs          - start a run (service-authenticated)
  GET  /internal/runs/{runId}  - agent-side state (service-authenticated)

There is deliberately NO endpoint to run an arbitrary command or prompt.
"""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status

from app.api.schemas import (
    CreateRunRequest,
    CreateRunResponse,
    HealthResponse,
    RunStateResponse,
)
from app.config import Settings, get_settings
from app.graph.backend_agent import RunRequest, run_backend_agent
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


def _execute_run(request: RunRequest, settings: Settings) -> None:
    # Runs in a background task; failures are recorded durably inside.
    run_backend_agent(request, settings)


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

    run_request = RunRequest(
        run_id=body.runId,
        graph_thread_id=str(run["graphThreadId"]),
        ticket_title=body.title,
        ticket_description=body.description or "",
        repo_config=repo,
        allowed_paths=allowed,
    )
    background.add_task(_execute_run, run_request, settings)
    return CreateRunResponse(runId=body.runId, status="RUNNING", accepted=True)


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
