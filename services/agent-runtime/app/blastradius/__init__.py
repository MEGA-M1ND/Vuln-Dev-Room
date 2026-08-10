"""Blast-radius analysis.

Answers "what would touching X affect?" for the repository a room works on,
from the code itself rather than from a document that went stale.

Deliberately read-only and sandbox-free: this parses an already-cloned tree and
shells out only to `git`, with argv lists and timeouts. It never executes
repository code, so unlike agent execution it needs no Docker isolation.

Every traversal here is bounded (file count, graph depth, node count,
subprocess time). An unbounded import walk over a large monorepo is a
denial-of-service against the runtime, not merely a slow request.
"""

from app.blastradius.graph import (
    ImportGraph,
    build_import_graph,
    GraphLimits,
)
from app.blastradius.impact import (
    AffectedFile,
    ImpactResult,
    ImpactLimits,
    compute_impact,
    resolve_seeds,
)
from app.blastradius.ownership import FileOwnership, OwnerStat, owners_for_paths

__all__ = [
    "ImportGraph",
    "build_import_graph",
    "GraphLimits",
    "AffectedFile",
    "ImpactResult",
    "ImpactLimits",
    "compute_impact",
    "resolve_seeds",
    "FileOwnership",
    "OwnerStat",
    "owners_for_paths",
]
