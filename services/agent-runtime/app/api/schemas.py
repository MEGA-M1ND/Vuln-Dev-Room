"""Pydantic request/response models for the internal API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class CreateRunRequest(BaseModel):
    runId: str
    roomId: str
    ticketId: str
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
