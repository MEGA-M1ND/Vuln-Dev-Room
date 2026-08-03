"""Resume endpoint guards (no background execution needed)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.persistence import runs as runs_db


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("DEVROOM_AGENT_SERVICE_TOKEN", "test-token")
    # get_settings is cached; clear it so the token is picked up.
    from app.config import get_settings

    get_settings.cache_clear()
    return TestClient(app)


def test_resume_requires_token(client):
    r = client.post("/internal/runs/x/resume", json={"decision": "approve"})
    assert r.status_code == 401


def test_resume_404_for_missing_run(client, monkeypatch):
    monkeypatch.setattr(runs_db, "get_run", lambda _rid: None)
    r = client.post(
        "/internal/runs/missing/resume",
        json={"decision": "approve"},
        headers={"X-Internal-Token": "test-token"},
    )
    assert r.status_code == 404


def test_resume_409_when_not_awaiting(client, monkeypatch):
    monkeypatch.setattr(
        runs_db, "get_run", lambda _rid: {"id": "r1", "status": "RUNNING", "roomId": "room"}
    )
    r = client.post(
        "/internal/runs/r1/resume",
        json={"decision": "approve"},
        headers={"X-Internal-Token": "test-token"},
    )
    assert r.status_code == 409


def test_reject_transitions_to_cancelled(client, monkeypatch):
    calls: dict[str, object] = {}
    monkeypatch.setattr(
        runs_db,
        "get_run",
        lambda _rid: {
            "id": "r1",
            "status": "AWAITING_APPROVAL",
            "roomId": "room",
            "targetRepositoryKey": "agentguard-demo",
        },
    )
    monkeypatch.setattr(
        runs_db,
        "update_run_status",
        lambda rid, s, **kw: calls.setdefault("status", (rid, s, kw)) or 2,
    )
    events: list[str] = []
    monkeypatch.setattr(
        runs_db, "append_event", lambda rid, t, **kw: events.append(t) or 1
    )

    r = client.post(
        "/internal/runs/r1/resume",
        json={"decision": "reject"},
        headers={"X-Internal-Token": "test-token"},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "CANCELLED"
    assert calls["status"][1] == "CANCELLED"
    assert "PLAN_REJECTED" in events
    assert "RUN_CANCELLED" in events


# --- Phase 1 control endpoints ---------------------------------------------


def test_cancel_requires_token(client):
    r = client.post("/internal/runs/x/cancel")
    assert r.status_code == 401


def test_redirect_requires_token(client):
    r = client.post("/internal/runs/x/redirect")
    assert r.status_code == 401


def test_cancel_404_for_missing_run(client, monkeypatch):
    monkeypatch.setattr(runs_db, "get_run", lambda _rid: None)
    r = client.post(
        "/internal/runs/missing/cancel", headers={"X-Internal-Token": "test-token"}
    )
    assert r.status_code == 404


def test_cancel_is_acknowledged_without_forcing_status(client, monkeypatch):
    """The endpoint acknowledges; the graph converges at its own checkpoint."""
    monkeypatch.setattr(
        runs_db, "get_run", lambda _rid: {"id": "r1", "status": "RUNNING", "roomId": "rm"}
    )
    called: list[str] = []
    monkeypatch.setattr(
        runs_db, "update_run_status", lambda *a, **k: called.append("forced") or 2
    )
    r = client.post(
        "/internal/runs/r1/cancel", headers={"X-Internal-Token": "test-token"}
    )
    assert r.status_code == 200
    assert r.json()["status"] == "RUNNING"
    assert called == []  # never forces a terminal status itself


def test_redirect_409_when_run_finished(client, monkeypatch):
    monkeypatch.setattr(
        runs_db,
        "get_run",
        lambda _rid: {"id": "r1", "status": "SUCCEEDED", "roomId": "rm"},
    )
    r = client.post(
        "/internal/runs/r1/redirect", headers={"X-Internal-Token": "test-token"}
    )
    assert r.status_code == 409


# --- Phase 3: mid-node steering ---------------------------------------------


def test_redirect_running_acknowledges_without_scheduling_replan(client, monkeypatch):
    """A still-executing run must NOT get a concurrently-scheduled replan —
    that would race against its own in-flight resume_run() rewinding the same
    checkpointed thread. Its own steerable checkpoints pick the guidance up."""
    import app.api.routes as routes

    monkeypatch.setattr(
        runs_db,
        "get_run",
        lambda _rid: {
            "id": "r1",
            "status": "RUNNING",
            "roomId": "rm",
            "targetRepositoryKey": "demo",
        },
    )
    scheduled: list[str] = []
    monkeypatch.setattr(
        routes, "_execute_replan", lambda *a, **k: scheduled.append("replan")
    )
    r = client.post(
        "/internal/runs/r1/redirect", headers={"X-Internal-Token": "test-token"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "RUNNING"
    assert body["accepted"] is True
    assert scheduled == []  # never scheduled


def test_redirect_at_gate_schedules_replan_immediately(client, monkeypatch):
    """A run parked at the approval gate has nothing else touching its
    checkpointed thread, so replanning it immediately is safe."""
    import app.api.routes as routes
    from app.config import RepositoryConfig

    monkeypatch.setattr(
        runs_db,
        "get_run",
        lambda _rid: {
            "id": "r1",
            "status": "AWAITING_APPROVAL",
            "roomId": "rm",
            "targetRepositoryKey": "demo",
            "graphThreadId": "thread-1",
            "baseRevision": "abc123",
        },
    )
    monkeypatch.setattr(
        routes,
        "_resolve_repo",
        lambda run, key, settings: RepositoryConfig(
            display_name="demo", source_path="/srv/demo"
        ),
    )
    scheduled: list[str] = []
    monkeypatch.setattr(
        routes, "_execute_replan", lambda *a, **k: scheduled.append("replan")
    )
    r = client.post(
        "/internal/runs/r1/redirect", headers={"X-Internal-Token": "test-token"}
    )
    assert r.status_code == 200
    assert r.json()["status"] == "RUNNING"
    assert scheduled == ["replan"]
