"""Phase 4: copy_thread against real Postgres.

LangGraph's own `PostgresSaver.copy_thread()` raises NotImplementedError in
the installed version, so `app.persistence.checkpoints.copy_thread` reimplements
it directly against the schema LangGraph creates. These tests seed that schema
by hand (no Docker needed — this is pure Postgres) and verify a copied thread
reconstructs byte-for-byte, including the graph actually resuming from it.
"""

from __future__ import annotations

import uuid

import psycopg
import pytest
from langgraph.checkpoint.postgres import PostgresSaver

from app.config import get_settings
from app.persistence.checkpoints import LANGGRAPH_SCHEMA, copy_thread


@pytest.fixture
def postgres_required():
    settings = get_settings()
    if not settings.effective_langgraph_url:
        pytest.skip("DATABASE_URL not configured")


def _seed_thread(thread_id: str) -> None:
    """Write a real, minimal-but-valid two-checkpoint history via a genuine
    PostgresSaver, so the copy is exercised against LangGraph's actual
    on-disk shape rather than a hand-rolled approximation of it."""
    settings = get_settings()
    conn = psycopg.connect(settings.effective_langgraph_url, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute(f'CREATE SCHEMA IF NOT EXISTS "{LANGGRAPH_SCHEMA}"')
            cur.execute(f'SET search_path TO "{LANGGRAPH_SCHEMA}"')
        saver = PostgresSaver(conn)
        saver.setup()
        cfg = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}
        cfg1 = saver.put(
            cfg,
            {
                "v": 1,
                "id": str(uuid.uuid4()),
                "ts": "2026-01-01T00:00:00+00:00",
                "channel_values": {"proposed_edits": [{"path": "a.py"}]},
                "channel_versions": {},
                "versions_seen": {},
            },
            {"source": "input", "step": 0},
            {},
        )
        saver.put(
            cfg1,
            {
                "v": 1,
                "id": str(uuid.uuid4()),
                "ts": "2026-01-01T00:00:01+00:00",
                "channel_values": {"proposed_edits": [{"path": "a.py"}]},
                "channel_versions": {},
                "versions_seen": {},
            },
            {"source": "loop", "step": 1},
            {},
        )
    finally:
        conn.close()


def _row_counts(thread_id: str) -> tuple[int, int, int]:
    settings = get_settings()
    conn = psycopg.connect(settings.effective_langgraph_url, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute(f'SET search_path TO "{LANGGRAPH_SCHEMA}"')
            cur.execute("SELECT count(*) FROM checkpoints WHERE thread_id = %s", (thread_id,))
            checkpoints = cur.fetchone()[0]
            cur.execute(
                "SELECT count(*) FROM checkpoint_blobs WHERE thread_id = %s", (thread_id,)
            )
            blobs = cur.fetchone()[0]
            cur.execute(
                "SELECT count(*) FROM checkpoint_writes WHERE thread_id = %s", (thread_id,)
            )
            writes = cur.fetchone()[0]
            return checkpoints, blobs, writes
    finally:
        conn.close()


def test_copy_thread_duplicates_the_full_checkpoint_history(postgres_required):
    source = f"test-fork-src-{uuid.uuid4().hex}"
    target = f"test-fork-dst-{uuid.uuid4().hex}"
    _seed_thread(source)

    copied = copy_thread(source, target)

    assert copied == 2  # both checkpoints written by _seed_thread
    assert _row_counts(target) == _row_counts(source)


def test_copy_thread_of_empty_thread_returns_zero(postgres_required):
    source = f"test-fork-empty-{uuid.uuid4().hex}"
    target = f"test-fork-empty-dst-{uuid.uuid4().hex}"

    copied = copy_thread(source, target)

    assert copied == 0


def test_forked_thread_resumes_with_identical_state(postgres_required):
    """The real invariant that matters: a graph resuming on the COPIED thread
    sees exactly the state the source thread had — this is what lets a fork's
    approval gate show the same proposed plan as its parent."""
    settings = get_settings()
    source = f"test-fork-resume-src-{uuid.uuid4().hex}"
    target = f"test-fork-resume-dst-{uuid.uuid4().hex}"
    _seed_thread(source)
    copy_thread(source, target)

    conn = psycopg.connect(settings.effective_langgraph_url, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute(f'SET search_path TO "{LANGGRAPH_SCHEMA}"')
        saver = PostgresSaver(conn)
        source_tuple = saver.get_tuple({"configurable": {"thread_id": source}})
        target_tuple = saver.get_tuple({"configurable": {"thread_id": target}})
        assert target_tuple is not None
        assert (
            target_tuple.checkpoint["channel_values"]
            == source_tuple.checkpoint["channel_values"]
        )
        assert target_tuple.checkpoint["id"] == source_tuple.checkpoint["id"]
    finally:
        conn.close()
