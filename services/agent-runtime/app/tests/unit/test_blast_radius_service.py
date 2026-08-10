"""Orchestration: seeds -> impact -> ownership -> summary.

Drives `compute_blast_radius` against a real local git repository with the clone
step stubbed, so the whole pipeline is exercised without network access.
"""

from __future__ import annotations

import os
import subprocess

import pytest

from app.blastradius import service as service_module
from app.blastradius.service import BlastRadiusRequest, compute_blast_radius
from app.models.base import ImpactSummaryRequest, render_default_impact_summary
from app.repository.clone import ClonedRepository


class _StubModel:
    """Stands in for a provider; records what it was asked to summarize."""

    name = "stub"

    def __init__(self) -> None:
        self.last_request: ImpactSummaryRequest | None = None

    def summarize_impact(self, request: ImpactSummaryRequest) -> str:
        self.last_request = request
        return render_default_impact_summary(request)


def _git(root: str, *args: str) -> None:
    subprocess.run(["git", "-C", root, *args], check=True, capture_output=True)


def _write(root: str, rel_path: str, text: str) -> None:
    full = os.path.join(root, rel_path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as handle:
        handle.write(text)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    root = str(tmp_path / "repo")
    os.makedirs(root)
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "ada@example.com")
    _git(root, "config", "user.name", "Ada Lovelace")

    _write(root, "tsconfig.json", '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}')
    _write(root, "src/lib/session.ts", "export const SESSION = 1;\n")
    _write(root, "src/lib/auth.ts", 'import { SESSION } from "./session";\nexport const auth = SESSION;\n')
    _write(root, "src/app/api/login/route.ts", 'import { auth } from "@/lib/auth";\nexport async function POST(){return auth;}\n')
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "init")

    # Bypass the network clone; the rest of the pipeline runs for real.
    service_module._CACHE.clear()
    monkeypatch.setattr(
        service_module._CACHE,
        "get",
        lambda owner, repo_name, revision, *, timeout: ClonedRepository(
            path=root, revision="HEAD"
        ),
    )
    return root


def test_computes_impact_owners_and_summary(repo):
    model = _StubModel()
    result = compute_blast_radius(
        BlastRadiusRequest(
            room_id="room-1",
            owner="astra",
            repo="payments-api",
            target_path="src/lib/session.ts",
            critical_paths=["src/lib/"],
        ),
        model=model,
    )

    paths = [f["path"] for f in result.affected_files]
    assert "src/lib/session.ts" in paths
    assert "src/lib/auth.ts" in paths
    assert "src/app/api/login/route.ts" in paths

    assert "/api/login" in result.api_endpoints_touched
    assert "src/lib/" in result.contracts_touched
    assert result.file_count == len(paths)

    # Ownership resolved from real git history.
    assert any(
        owner["email"] == "ada@example.com"
        for entry in result.owners
        for owner in entry["owners"]
    )
    assert "Ada Lovelace" in result.summary


def test_audience_changes_depth_not_facts(repo):
    def run(audience: str):
        return compute_blast_radius(
            BlastRadiusRequest(
                room_id="room-1",
                owner="astra",
                repo="payments-api",
                target_path="src/lib/session.ts",
                critical_paths=["src/lib/"],
                audience=audience,
            ),
            model=_StubModel(),
        )

    newcomer = run("VIEWER")
    senior = run("ENGINEER")

    # The newcomer gets more explanation...
    assert len(newcomer.summary) > len(senior.summary)
    # ...but the underlying facts are identical.
    assert newcomer.affected_files == senior.affected_files
    assert newcomer.contracts_touched == senior.contracts_touched
    # And the critical-path warning is never withheld from the senior reader.
    assert "critical" in senior.summary


def test_unmatched_query_reports_nothing_rather_than_guessing(repo):
    result = compute_blast_radius(
        BlastRadiusRequest(
            room_id="room-1",
            owner="astra",
            repo="payments-api",
            target_symbol="zzzznotathing",
        ),
        model=_StubModel(),
    )

    assert result.seeds == []
    assert result.affected_files == []
    assert result.file_count == 0
    assert "nothing to report" in result.summary


def test_summary_request_carries_the_real_findings(repo):
    model = _StubModel()
    compute_blast_radius(
        BlastRadiusRequest(
            room_id="room-1",
            owner="astra",
            repo="payments-api",
            target_path="src/lib/session.ts",
            critical_paths=["src/lib/"],
        ),
        model=model,
    )

    assert model.last_request is not None
    # The model summarizes what analysis found; it is never asked to invent it.
    assert "src/lib/auth.ts" in model.last_request.affected_paths
    assert model.last_request.critical_paths == ["src/lib/"]
