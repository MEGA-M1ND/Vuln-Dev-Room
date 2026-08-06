"""Reviewer-agent (roadmap Phase 5): review_run's own branching logic,
isolated from the model and Postgres persistence layers via monkeypatching —
matching this suite's established pattern for orchestrator-level unit tests
(see test_fork_run.py)."""

from __future__ import annotations

import pytest

import app.graph.backend_agent as backend_agent
from app.config import get_settings
from app.graph.backend_agent import review_run
from app.models.base import ReviewComment, ReviewResult
from app.persistence import artifacts as artifacts_db
from app.persistence import runs as runs_db


@pytest.fixture
def settings():
    return get_settings()


@pytest.fixture
def runs(monkeypatch):
    """A tiny in-memory run table the test controls directly."""
    table: dict[str, dict] = {}
    monkeypatch.setattr(runs_db, "get_run", lambda rid: table.get(rid))

    updates: list[tuple] = []

    def update_run_status(run_id, status, **kwargs):
        table[run_id] = {**table.get(run_id, {}), "status": status, **kwargs}
        updates.append((run_id, status, kwargs))
        return table[run_id].get("runVersion", 1) + 1

    monkeypatch.setattr(runs_db, "update_run_status", update_run_status)

    events: list[tuple] = []
    monkeypatch.setattr(
        runs_db,
        "append_event",
        lambda run_id, event_type, **kw: events.append((run_id, event_type, kw)) or 1,
    )

    table["_updates"] = updates  # type: ignore[assignment]
    table["_events"] = events  # type: ignore[assignment]
    return table


@pytest.fixture
def artifacts(monkeypatch):
    """A tiny in-memory artifact table, keyed by (run_id, type). Patching the
    module functions reaches backend_agent too — it imports the same module
    object as `artifacts_db`, not a copy of the functions."""
    table: dict[tuple[str, str], dict] = {}

    def get_artifact_by_type(run_id, artifact_type):
        return table.get((run_id, artifact_type))

    monkeypatch.setattr(artifacts_db, "get_artifact_by_type", get_artifact_by_type)

    recorded: list[dict] = []

    def append_artifact(run_id, artifact_type, title, **kwargs):
        recorded.append({"runId": run_id, "type": artifact_type, "title": title, **kwargs})
        return "artifact-id"

    monkeypatch.setattr(artifacts_db, "append_artifact", append_artifact)

    def seed(run_id, artifact_type, **fields):
        table[(run_id, artifact_type)] = fields

    return {"seed": seed, "recorded": recorded}


def test_review_fails_when_source_not_succeeded(settings, runs, artifacts):
    runs["source"] = {"id": "source", "status": "RUNNING"}
    runs["new"] = {"id": "new", "status": "QUEUED"}

    result = review_run("new", "source", settings)

    assert result == "FAILED"
    _, _, kwargs = runs["_updates"][-1]
    assert kwargs["error_code"] == "REVIEW_SOURCE_NOT_REVIEWABLE"


def test_review_fails_when_source_run_missing(settings, runs, artifacts):
    result = review_run("new", "does-not-exist", settings)

    assert result == "FAILED"
    _, _, kwargs = runs["_updates"][-1]
    assert kwargs["error_code"] == "REVIEW_SOURCE_NOT_REVIEWABLE"


def test_review_fails_when_new_run_row_missing(settings, runs, artifacts):
    runs["source"] = {"id": "source", "status": "SUCCEEDED"}

    result = review_run("new", "source", settings)

    assert result == "FAILED"
    _, _, kwargs = runs["_updates"][-1]
    assert kwargs["error_code"] == "AGENT_ERROR"


def test_review_posts_a_structured_review_and_succeeds(settings, runs, artifacts, monkeypatch):
    runs["source"] = {"id": "source", "status": "SUCCEEDED"}
    runs["new"] = {"id": "new", "status": "QUEUED"}
    artifacts["seed"]("source", "PLAN", contentText="Address task: t\n")
    artifacts["seed"]("source", "DIFF", contentText="diff --git a/x.py b/x.py\n")
    artifacts["seed"](
        "source", "TEST_RESULT", contentText="1 passed", metadataJson={"passed": True}
    )

    fake_result = ReviewResult(
        summary="Looks good.",
        verdict="approve",
        comments=[ReviewComment(path="x.py", severity="info", comment="ok")],
    )

    class _FakeModel:
        def review(self, request):
            # The request is built entirely from the source run's own
            # captured artifacts — never a fresh repository/sandbox read.
            assert request.plan_text == "Address task: t\n"
            assert request.test_passed is True
            return fake_result

    monkeypatch.setattr(backend_agent, "build_model", lambda _settings: _FakeModel())

    result = review_run("new", "source", settings)

    assert result == "SUCCEEDED"
    run_id, status_, _kwargs = runs["_updates"][-1]
    assert (run_id, status_) == ("new", "SUCCEEDED")

    event_types = [e[1] for e in runs["_events"] if e[0] == "new"]
    assert event_types == ["REVIEW_REQUESTED", "REVIEW_POSTED"]
    _, _, posted_kwargs = runs["_events"][-1]
    assert posted_kwargs["payload"]["verdict"] == "approve"
    assert posted_kwargs["payload"]["commentCount"] == 1
    assert posted_kwargs["payload"]["reviewedRunId"] == "source"

    assert len(artifacts["recorded"]) == 1
    review_artifact = artifacts["recorded"][0]
    assert review_artifact["type"] == "REVIEW"
    assert review_artifact["content_text"] == "Looks good."
    assert review_artifact["content_json"]["verdict"] == "approve"
    assert review_artifact["content_json"]["comments"] == [
        {"path": "x.py", "severity": "info", "comment": "ok"}
    ]


def test_review_fails_when_the_model_errors(settings, runs, artifacts, monkeypatch):
    runs["source"] = {"id": "source", "status": "SUCCEEDED"}
    runs["new"] = {"id": "new", "status": "QUEUED"}

    class _BrokenModel:
        def review(self, request):
            raise RuntimeError("boom")

    monkeypatch.setattr(backend_agent, "build_model", lambda _settings: _BrokenModel())

    result = review_run("new", "source", settings)

    assert result == "FAILED"
    _, _, kwargs = runs["_updates"][-1]
    assert kwargs["error_code"] == "AGENT_ERROR"
