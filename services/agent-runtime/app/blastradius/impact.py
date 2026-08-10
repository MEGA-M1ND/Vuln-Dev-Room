"""Seed resolution and reverse-dependency traversal.

The question "what would touching X affect?" is answered by walking the
**reverse** import graph: the things that would break are the things that import
X, and the things that import those, transitively. Walking forward instead would
answer "what does X depend on?", which is a different and much less useful
question before a change.
"""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field

from app.blastradius.graph import ImportGraph

# API surface detection. Next.js App Router puts one route per `route.ts`;
# FastAPI decorates handlers. Both are contract surfaces where a change is
# visible outside the repository, which is why they are called out separately
# from ordinary affected files.
_NEXT_ROUTE_RE = re.compile(r"(?:^|/)app/(.+?)/route\.(?:ts|js|tsx|jsx)$")
_FASTAPI_ROUTE_RE = re.compile(
    r"@(?:router|app)\.(get|post|put|patch|delete)\(\s*['\"]([^'\"]+)['\"]"
)


@dataclass(frozen=True)
class ImpactLimits:
    max_depth: int = 4
    max_nodes: int = 400
    max_seeds: int = 25


@dataclass
class AffectedFile:
    path: str
    #: 0 = the seed itself; 1 = imports the seed; 2 = imports an importer; …
    depth: int
    #: How many files import this one. A high count means wide reach.
    imported_by: int
    is_critical_path: bool = False

    def as_dict(self) -> dict[str, object]:
        return {
            "path": self.path,
            "depth": self.depth,
            "importedBy": self.imported_by,
            "isCriticalPath": self.is_critical_path,
        }


@dataclass
class ImpactResult:
    seeds: list[str] = field(default_factory=list)
    affected: list[AffectedFile] = field(default_factory=list)
    critical_paths_touched: list[str] = field(default_factory=list)
    api_endpoints_touched: list[str] = field(default_factory=list)
    truncated: bool = False

    def as_dict(self) -> dict[str, object]:
        return {
            "seeds": self.seeds,
            "affectedFiles": [a.as_dict() for a in self.affected],
            "contractsTouched": self.critical_paths_touched,
            "apiEndpointsTouched": self.api_endpoints_touched,
            "truncated": self.truncated,
        }


def _tokenize(description: str) -> list[str]:
    """Words worth matching a path against.

    Short tokens are dropped: matching on "the" or "to" would select the whole
    repository and produce a blast radius that says nothing.
    """
    stop = {
        "the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with",
        "add", "new", "fix", "update", "change", "make", "our", "this", "that",
        "we", "i", "it", "is", "are", "be", "should", "would", "can", "flow",
    }
    words = re.split(r"[^A-Za-z0-9_]+", description.lower())
    return [w for w in words if len(w) >= 3 and w not in stop]


def resolve_seeds(
    *,
    files: list[str],
    description: str | None = None,
    target_path: str | None = None,
    target_symbol: str | None = None,
    limits: ImpactLimits | None = None,
) -> list[str]:
    """Turn a query into concrete seed files.

    Deliberately heuristic and explainable rather than model-driven: a wrong
    seed silently produces a confident, wrong impact map, so the rule that
    picked a file should be one a human can read off the result. An exact path
    always wins over a guess.
    """
    limits = limits or ImpactLimits()

    if target_path:
        needle = target_path.replace("\\", "/").lstrip("./")
        exact = [f for f in files if f == needle]
        if exact:
            return exact[: limits.max_seeds]
        suffix = [f for f in files if f.endswith(needle)]
        if suffix:
            return sorted(suffix)[: limits.max_seeds]
        contains = [f for f in files if needle in f]
        return sorted(contains)[: limits.max_seeds]

    if target_symbol:
        symbol = target_symbol.lower()
        # Prefer a file named after the symbol; fall back to path substring.
        named = [f for f in files if f.rsplit("/", 1)[-1].split(".")[0].lower() == symbol]
        if named:
            return sorted(named)[: limits.max_seeds]
        return sorted(f for f in files if symbol in f.lower())[: limits.max_seeds]

    if description:
        tokens = _tokenize(description)
        if not tokens:
            return []
        scored: list[tuple[int, str]] = []
        for path in files:
            lowered = path.lower()
            score = sum(1 for token in tokens if token in lowered)
            if score:
                # Shallower paths are more likely to be the area, not a leaf test.
                scored.append((score * 10 - lowered.count("/"), path))
        scored.sort(key=lambda pair: (-pair[0], pair[1]))
        return [path for _, path in scored[: limits.max_seeds]]

    return []


def _matches_critical(path: str, critical_paths: list[str]) -> str | None:
    """Prefix match, mirroring `matchesCriticalPath` in src/lib/agent/signals.ts.

    Kept behaviourally identical on purpose: a file flagged critical in the room's
    risk signals must not be un-flagged here, or the two surfaces would disagree
    about the same file.
    """
    normalized = path.lstrip("./")
    for raw in critical_paths:
        prefix = raw.strip().lstrip("./")
        if not prefix:
            continue
        if normalized == prefix or normalized.startswith(prefix.rstrip("/") + "/"):
            return raw
        if prefix.endswith("/") and normalized.startswith(prefix):
            return raw
    return None


def _next_route_path(file_path: str) -> str | None:
    match = _NEXT_ROUTE_RE.search(file_path)
    if not match:
        return None
    segments = [
        seg
        for seg in match.group(1).split("/")
        # Route groups `(dashboard)` are organizational and not part of the URL.
        if not (seg.startswith("(") and seg.endswith(")"))
    ]
    return "/" + "/".join(segments) if segments else "/"


def compute_impact(
    graph: ImportGraph,
    seeds: list[str],
    *,
    critical_paths: list[str] | None = None,
    limits: ImpactLimits | None = None,
    read_text=None,
) -> ImpactResult:
    """Breadth-first walk of the reverse import graph from `seeds`.

    Breadth-first rather than depth-first so `depth` is the true shortest
    distance from a seed: "two hops from the thing you are changing" is a claim
    a reviewer can act on, and DFS would report whichever path it happened to
    find first.
    """
    limits = limits or ImpactLimits()
    critical = critical_paths or []
    result = ImpactResult(seeds=list(seeds), truncated=graph.truncated)

    seen: dict[str, int] = {}
    queue: deque[tuple[str, int]] = deque()
    for seed in seeds:
        if seed not in seen:
            seen[seed] = 0
            queue.append((seed, 0))

    while queue:
        path, depth = queue.popleft()

        if len(seen) > limits.max_nodes:
            result.truncated = True
            break

        if depth < limits.max_depth:
            for importer in sorted(graph.imported_by.get(path, ())):
                if importer not in seen:
                    seen[importer] = depth + 1
                    queue.append((importer, depth + 1))

    for path, depth in sorted(seen.items(), key=lambda kv: (kv[1], kv[0])):
        hit = _matches_critical(path, critical)
        result.affected.append(
            AffectedFile(
                path=path,
                depth=depth,
                imported_by=graph.importer_count(path),
                is_critical_path=hit is not None,
            )
        )
        if hit and hit not in result.critical_paths_touched:
            result.critical_paths_touched.append(hit)

        route = _next_route_path(path)
        if route and route not in result.api_endpoints_touched:
            result.api_endpoints_touched.append(route)
        elif read_text is not None and path.endswith(".py"):
            text = read_text(path)
            if text:
                for verb, url in _FASTAPI_ROUTE_RE.findall(text):
                    label = f"{verb.upper()} {url}"
                    if label not in result.api_endpoints_touched:
                        result.api_endpoints_touched.append(label)

    return result
