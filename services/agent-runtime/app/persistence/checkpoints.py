"""LangGraph checkpoint persistence.

Checkpoints are stored in a DEDICATED Postgres schema (`langgraph`) so LangGraph's
internal tables never collide with the Prisma-owned application tables. We pin the
connection's `search_path` to that schema; LangGraph then creates and uses its
tables there.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

import psycopg

from app.config import get_settings

LANGGRAPH_SCHEMA = "langgraph"

_setup_done = False


@contextmanager
def checkpointer_context() -> Iterator[object]:
    """Yield a LangGraph PostgresSaver bound to the `langgraph` schema.

    Falls back to an in-memory saver only when no database is configured (used by
    some unit tests). Production always uses Postgres.
    """
    settings = get_settings()
    url = settings.effective_langgraph_url

    if not url:
        from langgraph.checkpoint.memory import MemorySaver

        yield MemorySaver()
        return

    global _setup_done
    from langgraph.checkpoint.postgres import PostgresSaver

    # Ensure the schema exists, then pin search_path so all LangGraph DDL/DML
    # lands inside it.
    conn = psycopg.connect(url, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute(f'CREATE SCHEMA IF NOT EXISTS "{LANGGRAPH_SCHEMA}"')
            cur.execute(f'SET search_path TO "{LANGGRAPH_SCHEMA}"')
        saver = PostgresSaver(conn)
        if not _setup_done:
            saver.setup()
            _setup_done = True
        yield saver
    finally:
        conn.close()


def copy_thread(source_thread_id: str, target_thread_id: str) -> int:
    """Copy a LangGraph-checkpointed thread's full history to a new thread id.

    Phase 4 (fork a run): `PostgresSaver.copy_thread()` is declared on
    LangGraph's abstract base checkpointer but raises `NotImplementedError`
    for Postgres in the installed version, so this reimplements it directly
    against the schema LangGraph creates. All three tables key every row by
    `thread_id` as part of their composite primary key (checkpoints,
    checkpoint_blobs, checkpoint_writes), so copying every row for the source
    thread with only `thread_id` swapped preserves the *complete* checkpoint
    chain — every ancestor, and the writes/blobs each one depends on — which
    is exactly what LangGraph's own `copy_thread` contract requires (its
    docstring warns that copying only the latest checkpoint leaves a target
    thread unable to reconstruct `DeltaChannel` state; copying the whole
    thread's rows sidesteps that by construction, not by picking checkpoints).

    Returns how many checkpoint rows were copied, so a caller can treat 0 as
    "nothing to fork" — the target thread must not already exist.
    """
    settings = get_settings()
    url = settings.effective_langgraph_url
    if not url:
        raise RuntimeError("No LangGraph database configured; cannot fork a run.")

    conn = psycopg.connect(url, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute(f'SET search_path TO "{LANGGRAPH_SCHEMA}"')
            cur.execute(
                """
                INSERT INTO checkpoints
                    (thread_id, checkpoint_ns, checkpoint_id,
                     parent_checkpoint_id, type, checkpoint, metadata)
                SELECT %s, checkpoint_ns, checkpoint_id,
                       parent_checkpoint_id, type, checkpoint, metadata
                FROM checkpoints WHERE thread_id = %s
                """,
                (target_thread_id, source_thread_id),
            )
            copied = cur.rowcount
            cur.execute(
                """
                INSERT INTO checkpoint_blobs
                    (thread_id, checkpoint_ns, channel, version, type, blob)
                SELECT %s, checkpoint_ns, channel, version, type, blob
                FROM checkpoint_blobs WHERE thread_id = %s
                """,
                (target_thread_id, source_thread_id),
            )
            cur.execute(
                """
                INSERT INTO checkpoint_writes
                    (thread_id, checkpoint_ns, checkpoint_id, task_id, idx,
                     channel, type, blob, task_path)
                SELECT %s, checkpoint_ns, checkpoint_id, task_id, idx,
                       channel, type, blob, task_path
                FROM checkpoint_writes WHERE thread_id = %s
                """,
                (target_thread_id, source_thread_id),
            )
        return copied
    finally:
        conn.close()
