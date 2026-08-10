"""Import-graph construction and reverse-impact traversal."""

from __future__ import annotations

import os
import subprocess

import pytest

from app.blastradius.graph import (
    GraphLimits,
    build_import_graph,
    default_alias_roots,
)
from app.blastradius.impact import (
    ImpactLimits,
    compute_impact,
    resolve_seeds,
)
from app.blastradius.ownership import has_touched, owners_for_paths


def write(root, rel_path: str, text: str = "") -> str:
    full = os.path.join(root, rel_path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as handle:
        handle.write(text)
    return rel_path


@pytest.fixture
def ts_repo(tmp_path):
    """A small TS tree: session <- auth <- login-form, plus an API route."""
    root = str(tmp_path)
    files = [
        write(root, "tsconfig.json", '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}'),
        write(root, "src/lib/session.ts", "export const SESSION = 1;\n"),
        write(
            root,
            "src/lib/auth.ts",
            'import { SESSION } from "./session";\nexport const auth = SESSION;\n',
        ),
        write(
            root,
            "src/components/login-form.tsx",
            'import { auth } from "@/lib/auth";\nimport React from "react";\nexport default auth;\n',
        ),
        write(
            root,
            "src/app/api/login/route.ts",
            'import { auth } from "@/lib/auth";\nexport async function POST() { return auth; }\n',
        ),
        write(root, "src/unrelated/chart.ts", "export const chart = 2;\n"),
    ]
    return root, files


def test_relative_and_alias_imports_resolve(ts_repo):
    root, files = ts_repo
    graph = build_import_graph(root, files)

    assert "src/lib/session.ts" in graph.imports["src/lib/auth.ts"]
    # `@/lib/auth` resolves through tsconfig paths.
    assert "src/lib/auth.ts" in graph.imports["src/components/login-form.tsx"]


def test_bare_specifiers_are_not_graph_nodes(ts_repo):
    root, files = ts_repo
    graph = build_import_graph(root, files)

    # `react` lives outside the repo and cannot be affected by a change here.
    assert not any("react" in target for target in graph.imports["src/components/login-form.tsx"])


def test_reverse_edges_are_recorded(ts_repo):
    root, files = ts_repo
    graph = build_import_graph(root, files)

    assert graph.imported_by["src/lib/auth.ts"] == {
        "src/components/login-form.tsx",
        "src/app/api/login/route.ts",
    }
    assert graph.importer_count("src/lib/auth.ts") == 2


def test_tsconfig_alias_is_read(ts_repo):
    root, _ = ts_repo
    assert default_alias_roots(root)["@/"] == "src/"


def test_impact_walks_reverse_graph_with_true_shortest_depth(ts_repo):
    root, files = ts_repo
    graph = build_import_graph(root, files)

    result = compute_impact(graph, ["src/lib/session.ts"])
    by_path = {a.path: a.depth for a in result.affected}

    assert by_path["src/lib/session.ts"] == 0
    assert by_path["src/lib/auth.ts"] == 1
    # Two hops: session <- auth <- login-form.
    assert by_path["src/components/login-form.tsx"] == 2
    # Never imported, transitively or otherwise.
    assert "src/unrelated/chart.ts" not in by_path


def test_impact_surfaces_next_api_routes(ts_repo):
    root, files = ts_repo
    graph = build_import_graph(root, files)

    result = compute_impact(graph, ["src/lib/auth.ts"])
    assert "/api/login" in result.api_endpoints_touched


def test_impact_flags_critical_paths(ts_repo):
    root, files = ts_repo
    graph = build_import_graph(root, files)

    result = compute_impact(graph, ["src/lib/session.ts"], critical_paths=["src/lib/"])
    critical = {a.path for a in result.affected if a.is_critical_path}

    assert "src/lib/session.ts" in critical
    assert "src/lib/auth.ts" in critical
    assert "src/lib/" in result.critical_paths_touched
    assert "src/components/login-form.tsx" not in critical


def test_depth_limit_truncates_the_walk(ts_repo):
    root, files = ts_repo
    graph = build_import_graph(root, files)

    result = compute_impact(
        graph, ["src/lib/session.ts"], limits=ImpactLimits(max_depth=1)
    )
    paths = {a.path for a in result.affected}

    assert "src/lib/auth.ts" in paths
    # Depth 2 is beyond the limit.
    assert "src/components/login-form.tsx" not in paths


def test_node_cap_marks_result_truncated(ts_repo):
    root, files = ts_repo
    graph = build_import_graph(root, files)

    result = compute_impact(
        graph, ["src/lib/session.ts"], limits=ImpactLimits(max_nodes=1)
    )
    assert result.truncated is True


def test_file_cap_marks_graph_truncated(ts_repo):
    root, files = ts_repo
    graph = build_import_graph(root, files, limits=GraphLimits(max_files=1))
    assert graph.truncated is True


# --- Python resolution -----------------------------------------------------


@pytest.fixture
def py_repo(tmp_path):
    root = str(tmp_path)
    files = [
        write(root, "pkg/__init__.py"),
        write(root, "pkg/models.py", "VALUE = 1\n"),
        write(root, "pkg/service.py", "from pkg.models import VALUE\n"),
        write(root, "pkg/relative.py", "from .models import VALUE\n"),
        write(root, "pkg/api.py", "from app.blastradius import nothing\n"),
    ]
    return root, files


def test_absolute_python_import_resolves(py_repo):
    root, files = py_repo
    graph = build_import_graph(root, files)
    assert "pkg/models.py" in graph.imports["pkg/service.py"]


def test_relative_python_import_resolves(py_repo):
    root, files = py_repo
    graph = build_import_graph(root, files)
    assert "pkg/models.py" in graph.imports["pkg/relative.py"]


def test_unresolvable_python_import_is_dropped(py_repo):
    root, files = py_repo
    graph = build_import_graph(root, files)
    # `app.blastradius` is not in this tree; no phantom node may appear.
    assert graph.imports.get("pkg/api.py", set()) == set()


def test_unparseable_source_costs_only_its_own_edges(tmp_path):
    root = str(tmp_path)
    files = [
        write(root, "good.py", "import broken\n"),
        write(root, "broken.py", "def (((:\n"),
    ]
    graph = build_import_graph(root, files)
    # The graph still builds; the broken file simply contributes no edges.
    assert "broken.py" in graph.imports["good.py"]
    assert graph.imports.get("broken.py", set()) == set()


# --- Seed resolution -------------------------------------------------------


FILES = [
    "src/lib/auth/session.ts",
    "src/lib/auth/login.ts",
    "src/lib/billing/invoice.ts",
    "src/components/nav.tsx",
]


def test_exact_target_path_wins():
    assert resolve_seeds(files=FILES, target_path="src/lib/auth/session.ts") == [
        "src/lib/auth/session.ts"
    ]


def test_target_path_falls_back_to_suffix_match():
    assert resolve_seeds(files=FILES, target_path="auth/login.ts") == [
        "src/lib/auth/login.ts"
    ]


def test_symbol_prefers_a_file_named_after_it():
    assert resolve_seeds(files=FILES, target_symbol="invoice") == [
        "src/lib/billing/invoice.ts"
    ]


def test_description_matches_on_meaningful_tokens():
    seeds = resolve_seeds(files=FILES, description="change the auth session handling")
    assert "src/lib/auth/session.ts" in seeds


def test_description_of_only_stopwords_selects_nothing():
    # Matching on "the"/"to" would select the entire repository.
    assert resolve_seeds(files=FILES, description="we should change the flow") == []


# --- Ownership -------------------------------------------------------------


def _git(root: str, *args: str) -> None:
    subprocess.run(["git", "-C", root, *args], check=True, capture_output=True)


@pytest.fixture
def git_repo(tmp_path):
    root = str(tmp_path)
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "ada@example.com")
    _git(root, "config", "user.name", "Ada Lovelace")
    write(root, "src/thing.ts", "export const a = 1;\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "first")
    return root


def test_ownership_is_derived_from_git_history(git_repo):
    ownership = owners_for_paths(git_repo, ["src/thing.ts"])

    assert len(ownership) == 1
    owners = ownership[0].owners
    assert owners[0].email == "ada@example.com"
    assert owners[0].name == "Ada Lovelace"
    assert owners[0].commits == 1


def test_has_touched_reports_prior_work_in_the_area(git_repo):
    ownership = owners_for_paths(git_repo, ["src/thing.ts"])

    assert has_touched(ownership, "ada@example.com") is True
    assert has_touched(ownership, "grace@example.com") is False
    assert has_touched(ownership, "") is False


def test_untracked_path_yields_no_owners(git_repo):
    assert owners_for_paths(git_repo, ["src/does-not-exist.ts"]) == []
