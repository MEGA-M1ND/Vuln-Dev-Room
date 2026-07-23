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
