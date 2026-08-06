"""Pydantic request/response models for the internal API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class CreateRunRequest(BaseModel):
    runId: str
    roomId: str
    taskId: str
    title: str
    description: str | None = None
    agentId: str = "backend-agent"
    targetRepositoryKey: str
    # Allow-list forwarded from the app; the runtime also intersects this with
    # the repository's own configured allowed_paths (defense in depth).
    allowedPaths: list[str] = Field(default_factory=list)
    requestedById: str


class CreateRunResponse(BaseModel):
    runId: str
    status: str
    accepted: bool


class ResumeRunRequest(BaseModel):
    decision: Literal["approve", "reject"]


class ResumeRunResponse(BaseModel):
    runId: str
    status: str
    accepted: bool


class RunStateResponse(BaseModel):
    runId: str
    status: str
    runVersion: int
    agentId: str
    targetRepositoryKey: str
    baseRevision: str | None = None
    errorCode: str | None = None
    errorSummary: str | None = None


class HealthResponse(BaseModel):
    status: str
    dockerAvailable: bool
    modelProvider: str
    repositoryCount: int


class ControlResponse(BaseModel):
    """Response for the Phase 1 control endpoints (cancel / redirect)."""

    runId: str
    status: str
    accepted: bool


class ForkRunRequest(BaseModel):
    """Fork (roadmap Phase 4): the source run this new run's checkpointed
    thread should be copied from. The new run row itself is already created
    (by the web app) before this is called."""

    sourceRunId: str


class ReviewRunRequest(BaseModel):
    """Reviewer-agent (roadmap Phase 5): the source run to review. The new
    run row itself is already created (by the web app, on the source's own
    task) before this is called."""

    sourceRunId: str
