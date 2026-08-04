"""Fork (roadmap Phase 4): fork_run's own branching logic, isolated from
copy_thread and the Postgres persistence layer (each already covered
independently — copy_thread in test_checkpoint_fork.py, runs_db everywhere
else) via monkeypatching, matching this suite's established pattern for
orchestrator-level unit tests."""

from __future__ import annotations

from contextlib import contextmanager

import pytest

import app.graph.backend_agent as backend_agent
from app.config import get_settings
from app.graph.backend_agent import fork_run
from app.persistence import runs as runs_db


class _FakeTuple:
    def __init__(self, channel_values: dict) -> None:
        self.checkpoint = {"channel_values": channel_values}


class _FakeCheckpointer:
    def __init__(self, tuple_: _FakeTuple | None) -> None:
        self._tuple = tuple_

    def get_tuple(self, _cfg):
        return self._tuple


@contextmanager
def _fake_checkpointer_context(tuple_: _FakeTuple | None):
    yield _FakeCheckpointer(tuple_)


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


def test_fork_fails_when_source_not_awaiting_approval(settings, runs):
    runs["source"] = {"id": "source", "status": "RUNNING", "graphThreadId": "t-source"}
    runs["new"] = {"id": "new", "status": "QUEUED", "graphThreadId": "t-new"}

    result = fork_run("new", "source", settings)

    assert result == "FAILED"
    _, _, kwargs = runs["_updates"][-1]
    assert kwargs["error_code"] == "FORK_SOURCE_NOT_FORKABLE"


def test_fork_fails_when_source_run_missing(settings, runs):
    runs["new"] = {"id": "new", "status": "QUEUED", "graphThreadId": "t-new"}

    result = fork_run("new", "does-not-exist", settings)

    assert result == "FAILED"


def test_fork_fails_when_new_run_row_missing(settings, runs):
    runs["source"] = {"id": "source", "status": "AWAITING_APPROVAL", "graphThreadId": "t-source"}

    result = fork_run("new", "source", settings)

    assert result == "FAILED"
    _, _, kwargs = runs["_updates"][-1]
    assert kwargs["error_code"] == "AGENT_ERROR"


def test_fork_fails_when_nothing_was_copied(settings, runs, monkeypatch):
    runs["source"] = {
        "id": "source",
        "status": "AWAITING_APPROVAL",
        "graphThreadId": "t-source",
        "baseRevision": "abc123",
    }
    runs["new"] = {"id": "new", "status": "QUEUED", "graphThreadId": "t-new"}
    monkeypatch.setattr(backend_agent, "copy_thread", lambda src, dst: 0)

    result = fork_run("new", "source", settings)

    assert result == "FAILED"
    _, _, kwargs = runs["_updates"][-1]
    assert kwargs["error_code"] == "FORK_SOURCE_NOT_FORKABLE"


def test_fork_copies_checkpoint_and_reaches_the_gate(settings, runs, monkeypatch):
    runs["source"] = {
        "id": "source",
        "status": "AWAITING_APPROVAL",
        "graphThreadId": "t-source",
        "baseRevision": "abc123",
    }
    runs["new"] = {"id": "new", "status": "QUEUED", "graphThreadId": "t-new"}

    copy_calls: list[tuple[str, str]] = []
    monkeypatch.setattr(
        backend_agent,
        "copy_thread",
        lambda src, dst: copy_calls.append((src, dst)) or 3,
    )
    monkeypatch.setattr(
        backend_agent,
        "checkpointer_context",
        lambda: _fake_checkpointer_context(
            _FakeTuple({"proposed_edits": [{"path": "backend/x.py", "new_content": "..."}]})
        ),
    )

    result = fork_run("new", "source", settings)

    assert result == "AWAITING_APPROVAL"
    assert copy_calls == [("t-source", "t-new")]

    run_id, status_, kwargs = runs["_updates"][-1]
    assert (run_id, status_) == ("new", "AWAITING_APPROVAL")
    assert kwargs["base_revision"] == "abc123"  # copied from the source

    run_id, event_type, kwargs = runs["_events"][-1]
    assert (run_id, event_type) == ("new", "APPROVAL_REQUESTED")
    assert kwargs["payload"]["proposedFiles"] == ["backend/x.py"]
    assert kwargs["payload"]["forkedFrom"] == "source"
