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
