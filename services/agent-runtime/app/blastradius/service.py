"""Blast-radius orchestration: clone -> graph -> impact -> ownership -> summary.

Reuses the runtime's existing repository plumbing rather than introducing a
second way to obtain a working tree. A blast-radius query and an agent run must
analyse the *same* revision of the *same* repository, or the impact map would
describe code the agent is not about to touch.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field

from app.blastradius.graph import GraphLimits, build_import_graph
from app.blastradius.impact import ImpactLimits, compute_impact, resolve_seeds
from app.blastradius.ownership import owners_for_paths
from app.models.base import ImpactSummaryRequest
from app.repository.clone import (
    ClonedRepository,
    RepositorySourceError,
    clone_repository,
    github_https_url,
    list_tracked_files,
)


@dataclass
class BlastRadiusRequest:
    room_id: str
    owner: str
    repo: str
    revision: str = "HEAD"
    description: str | None = None
    target_path: str | None = None
    target_symbol: str | None = None
    critical_paths: list[str] = field(default_factory=list)
    audience: str = "ENGINEER"


@dataclass
class BlastRadiusResponse:
    seeds: list[str]
    affected_files: list[dict[str, object]]
    contracts_touched: list[str]
    api_endpoints_touched: list[str]
    owners: list[dict[str, object]]
    summary: str
    file_count: int
    truncated: bool

    def as_dict(self) -> dict[str, object]:
        return {
            "seeds": self.seeds,
            "affectedFiles": self.affected_files,
            "contractsTouched": self.contracts_touched,
            "apiEndpointsTouched": self.api_endpoints_touched,
            "owners": self.owners,
            "summary": self.summary,
            "fileCount": self.file_count,
            "truncated": self.truncated,
        }


class _CloneCache:
    """One working tree per (owner, repo, revision), reused across queries.

    Cloning is by far the slowest step, and a room asking three "what if" questions
    in a planning conversation should pay for it once. Guarded by a lock because
    FastAPI serves requests concurrently and two queries racing on the same repo
    would otherwise clone over each other.
    """

    def __init__(self) -> None:
        self._entries: dict[tuple[str, str, str], ClonedRepository] = {}
        self._lock = threading.Lock()

    def get(
        self, owner: str, repo: str, revision: str, *, timeout: int
    ) -> ClonedRepository:
        key = (owner, repo, revision)
        with self._lock:
            cached = self._entries.get(key)
            if cached is not None and os.path.isdir(cached.path):
                return cached

            cloned = clone_repository(
                github_https_url(owner, repo),
                ref=revision,
                pinned_sha=None,
                timeout=timeout,
            )
            self._entries[key] = cloned
            return cloned

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


_CACHE = _CloneCache()


def compute_blast_radius(
    request: BlastRadiusRequest,
    *,
    model,
    clone_timeout: int = 120,
    graph_limits: GraphLimits | None = None,
    impact_limits: ImpactLimits | None = None,
) -> BlastRadiusResponse:
    """Answer one blast-radius query.

    Raises `RepositorySourceError` when the repository cannot be obtained; the
    caller maps that to a 400 rather than a 500, because an unreachable repo is
    a bad request about the room's configuration, not a runtime fault.
    """
    cloned = _CACHE.get(
        request.owner,
        request.repo,
        request.revision,
        timeout=clone_timeout,
    )

    tracked = list_tracked_files(cloned.path)
    graph = build_import_graph(cloned.path, tracked, limits=graph_limits)

    seeds = resolve_seeds(
        files=sorted(graph.files),
        description=request.description,
        target_path=request.target_path,
        target_symbol=request.target_symbol,
        limits=impact_limits,
    )

    if not seeds:
        # An honest empty answer. Guessing a seed here would produce a
        # confident impact map for a file the asker never meant.
        return BlastRadiusResponse(
            seeds=[],
            affected_files=[],
            contracts_touched=[],
            api_endpoints_touched=[],
            owners=[],
            summary=(
                "No files in this repository matched that query, so there is "
                "nothing to report. Try naming a path or a symbol."
            ),
            file_count=0,
            truncated=graph.truncated,
        )

    def _read(rel_path: str) -> str | None:
        full = os.path.join(cloned.path, rel_path)
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as handle:
                return handle.read()
        except OSError:
            return None

    impact = compute_impact(
        graph,
        seeds,
        critical_paths=request.critical_paths,
        limits=impact_limits,
        read_text=_read,
    )

    affected_paths = [a.path for a in impact.affected]
    ownership = owners_for_paths(cloned.path, affected_paths)

    owner_names: list[str] = []
    for entry in ownership:
        for stat in entry.owners:
            if stat.name not in owner_names:
                owner_names.append(stat.name)

    summary = model.summarize_impact(
        ImpactSummaryRequest(
            query=request.target_path
            or request.target_symbol
            or (request.description or "this area"),
            seeds=seeds,
            affected_paths=affected_paths,
            critical_paths=impact.critical_paths_touched,
            api_endpoints=impact.api_endpoints_touched,
            owners=owner_names,
            audience=request.audience,
            truncated=impact.truncated,
        )
    )

    return BlastRadiusResponse(
        seeds=seeds,
        affected_files=[a.as_dict() for a in impact.affected],
        contracts_touched=impact.critical_paths_touched,
        api_endpoints_touched=impact.api_endpoints_touched,
        owners=[entry.as_dict() for entry in ownership],
        summary=summary,
        file_count=len(affected_paths),
        truncated=impact.truncated,
    )


__all__ = [
    "BlastRadiusRequest",
    "BlastRadiusResponse",
    "RepositorySourceError",
    "compute_blast_radius",
]
