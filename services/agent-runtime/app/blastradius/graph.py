"""Import-graph construction for JS/TS and Python source trees.

The graph is built from *repo-relative* paths throughout. Absolute host paths
never enter the graph, so a result can be rendered in a browser without leaking
where the clone happened to land on disk.

Only edges we can resolve to a file **inside the repository** are recorded. A
bare specifier (`react`, `os`, `fastapi`) is a dependency on something outside
the tree; it cannot be "affected" by a change in this repo, and inventing a node
for it would inflate every blast radius with noise.
"""

from __future__ import annotations

import ast
import os
import re
from dataclasses import dataclass, field

# --- What we parse ---------------------------------------------------------

JS_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
PY_EXTENSIONS = (".py",)
SOURCE_EXTENSIONS = JS_EXTENSIONS + PY_EXTENSIONS

# Directories that are never first-party source. Skipped before reading, so a
# vendored tree costs nothing.
SKIP_DIRECTORIES = frozenset(
    {
        "node_modules",
        ".git",
        ".next",
        "dist",
        "build",
        "out",
        "coverage",
        "__pycache__",
        ".venv",
        "venv",
        ".mypy_cache",
        ".pytest_cache",
        ".turbo",
        "vendor",
        "third_party",
    }
)

# `import x from "y"`, `export … from "y"`, `require("y")`, `import("y")`.
# One regex over the file beats a full TS parse we cannot run from Python, and
# is resilient to syntax we do not model (decorators, generics, JSX).
_JS_IMPORT_RE = re.compile(
    r"""(?:
          (?:\bimport\b|\bexport\b)[^;'"]*?from\s*['"](?P<from>[^'"]+)['"]
        | \bimport\s*['"](?P<bare>[^'"]+)['"]
        | \brequire\s*\(\s*['"](?P<req>[^'"]+)['"]\s*\)
        | \bimport\s*\(\s*['"](?P<dyn>[^'"]+)['"]\s*\)
    )""",
    re.VERBOSE,
)


@dataclass(frozen=True)
class GraphLimits:
    """Hard bounds. Exceeding one truncates rather than raising: a partial
    graph with `truncated=True` is more useful than an error, and the caller
    surfaces the flag so nobody mistakes a partial answer for a complete one."""

    max_files: int = 5_000
    max_file_bytes: int = 512 * 1024
    max_edges: int = 50_000


@dataclass
class ImportGraph:
    """Forward and reverse adjacency over repo-relative paths."""

    # importer -> set of repo-relative paths it imports
    imports: dict[str, set[str]] = field(default_factory=dict)
    # imported -> set of repo-relative paths that import it
    imported_by: dict[str, set[str]] = field(default_factory=dict)
    files: set[str] = field(default_factory=set)
    truncated: bool = False

    def add_edge(self, importer: str, imported: str) -> None:
        self.imports.setdefault(importer, set()).add(imported)
        self.imported_by.setdefault(imported, set()).add(importer)

    def importer_count(self, path: str) -> int:
        return len(self.imported_by.get(path, ()))

    @property
    def edge_count(self) -> int:
        return sum(len(v) for v in self.imports.values())


def _normalize(path: str) -> str:
    return path.replace(os.sep, "/").lstrip("./")


def _is_source(path: str) -> bool:
    return path.endswith(SOURCE_EXTENSIONS)


def _read_text(root: str, rel_path: str, limit: int) -> str | None:
    """Read a file defensively. Unreadable or oversized files are skipped, not
    fatal — one binary blob mislabelled `.ts` must not fail the whole graph."""
    full = os.path.join(root, rel_path)
    try:
        if os.path.getsize(full) > limit:
            return None
        with open(full, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except (OSError, ValueError):
        return None


# --- JS/TS resolution ------------------------------------------------------


def _js_candidates(base: str) -> list[str]:
    """Specifier -> the concrete files it could mean, in resolution order."""
    out = [base + ext for ext in JS_EXTENSIONS]
    out.append(base)  # already had an extension
    out.extend(f"{base}/index{ext}" for ext in JS_EXTENSIONS)
    return out


def _resolve_js(
    specifier: str,
    importer: str,
    file_set: set[str],
    alias_roots: dict[str, str],
) -> str | None:
    if specifier.startswith("."):
        base = _normalize(os.path.normpath(os.path.join(os.path.dirname(importer), specifier)))
    else:
        # Alias (`@/lib/x` -> `src/lib/x`). Longest prefix wins so `@ui/` beats `@`.
        base = None
        for prefix in sorted(alias_roots, key=len, reverse=True):
            if specifier == prefix.rstrip("/") or specifier.startswith(prefix):
                remainder = specifier[len(prefix) :] if specifier.startswith(prefix) else ""
                base = _normalize(f"{alias_roots[prefix].rstrip('/')}/{remainder}".rstrip("/"))
                break
        if base is None:
            return None  # bare specifier: outside the repo

    for candidate in _js_candidates(base):
        normalized = _normalize(candidate)
        if normalized in file_set:
            return normalized
    return None


def default_alias_roots(root: str) -> dict[str, str]:
    """Read `compilerOptions.paths` from tsconfig if present.

    Parsed with a regex rather than `json` because tsconfig routinely contains
    comments and trailing commas, which `json.loads` rejects. A miss here costs
    only a few unresolved edges, so a tolerant reader beats a strict one.
    """
    aliases: dict[str, str] = {}
    for name in ("tsconfig.json", "jsconfig.json"):
        text = _read_text(root, name, 256 * 1024)
        if not text:
            continue
        for alias, target in re.findall(
            r'"([^"]+)\*"\s*:\s*\[\s*"([^"]+)\*"', text
        ):
            aliases[alias] = target.lstrip("./")
    if not aliases and os.path.isdir(os.path.join(root, "src")):
        aliases["@/"] = "src/"
    return aliases


# --- Python resolution -----------------------------------------------------


def _module_candidates(dotted: str, source_roots: list[str]) -> list[str]:
    as_path = dotted.replace(".", "/")
    out: list[str] = []
    for source_root in source_roots:
        prefix = f"{source_root.rstrip('/')}/" if source_root else ""
        out.append(f"{prefix}{as_path}.py")
        out.append(f"{prefix}{as_path}/__init__.py")
    return [_normalize(p) for p in out]


def _resolve_python_module(
    dotted: str, file_set: set[str], source_roots: list[str]
) -> str | None:
    for candidate in _module_candidates(dotted, source_roots):
        if candidate in file_set:
            return candidate
    return None


def _python_edges(
    text: str, importer: str, file_set: set[str], source_roots: list[str]
) -> set[str]:
    """Resolve a Python file's imports using the real AST.

    A syntax error is not fatal: the repository under analysis may target a
    different Python version than the runtime, and one unparseable file should
    cost that file's edges, not the whole graph.
    """
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError, RecursionError):
        return set()

    package_dir = os.path.dirname(importer)
    found: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                hit = _resolve_python_module(alias.name, file_set, source_roots)
                if hit:
                    found.add(hit)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                # Relative: walk up `level - 1` directories from the package.
                base = package_dir
                for _ in range(node.level - 1):
                    base = os.path.dirname(base)
                dotted = node.module.replace(".", "/") if node.module else ""
                target = _normalize(os.path.normpath(os.path.join(base, dotted))) if dotted else _normalize(base)
                for candidate in (f"{target}.py", f"{target}/__init__.py"):
                    if _normalize(candidate) in file_set:
                        found.add(_normalize(candidate))
                        break
                # `from .pkg import name` may name a module rather than a symbol.
                for alias in node.names:
                    sub = _normalize(os.path.normpath(os.path.join(target, alias.name)))
                    for candidate in (f"{sub}.py", f"{sub}/__init__.py"):
                        if _normalize(candidate) in file_set:
                            found.add(_normalize(candidate))
                            break
            elif node.module:
                hit = _resolve_python_module(node.module, file_set, source_roots)
                if hit:
                    found.add(hit)
                for alias in node.names:
                    hit_sub = _resolve_python_module(
                        f"{node.module}.{alias.name}", file_set, source_roots
                    )
                    if hit_sub:
                        found.add(hit_sub)
    return found


def python_source_roots(file_set: set[str]) -> list[str]:
    """Prefixes a dotted module might be rooted at.

    `""` (repo root) always applies; `src/` and `app/` are added when present so
    a `src`-layout package resolves without configuration.
    """
    roots = [""]
    for candidate in ("src", "app", "services"):
        if any(f.startswith(f"{candidate}/") for f in file_set):
            roots.append(candidate)
    return roots


# --- Public entry point ----------------------------------------------------


def build_import_graph(
    root: str,
    tracked_files: list[str],
    *,
    limits: GraphLimits | None = None,
    alias_roots: dict[str, str] | None = None,
) -> ImportGraph:
    """Build the import graph for a cloned repository.

    `tracked_files` comes from `list_tracked_files()` (git), so untracked build
    output and ignored directories are already excluded before we start.
    """
    limits = limits or GraphLimits()
    aliases = alias_roots if alias_roots is not None else default_alias_roots(root)

    normalized = [_normalize(p) for p in tracked_files]
    sources = [
        p
        for p in normalized
        if _is_source(p) and not any(part in SKIP_DIRECTORIES for part in p.split("/"))
    ]

    graph = ImportGraph()
    if len(sources) > limits.max_files:
        sources = sources[: limits.max_files]
        graph.truncated = True

    file_set = set(normalized)
    graph.files = set(sources)
    py_roots = python_source_roots(file_set)

    for rel_path in sources:
        if graph.edge_count >= limits.max_edges:
            graph.truncated = True
            break

        text = _read_text(root, rel_path, limits.max_file_bytes)
        if text is None:
            continue

        if rel_path.endswith(PY_EXTENSIONS):
            for target in _python_edges(text, rel_path, file_set, py_roots):
                if target != rel_path:
                    graph.add_edge(rel_path, target)
        else:
            for match in _JS_IMPORT_RE.finditer(text):
                specifier = (
                    match.group("from")
                    or match.group("bare")
                    or match.group("req")
                    or match.group("dyn")
                )
                if not specifier:
                    continue
                target = _resolve_js(specifier, rel_path, file_set, aliases)
                if target and target != rel_path:
                    graph.add_edge(rel_path, target)

    return graph
