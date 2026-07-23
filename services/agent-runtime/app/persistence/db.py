"""Low-level DB helpers.

The agent runtime writes to the SAME Postgres database that Prisma owns, but only
to the Stage 2 run tables (AgentRun / RunArtifact / RunEvent). It never alters
Stage 1 tables. Table and column identifiers are Prisma's quoted PascalCase /
camelCase names.
"""

from __future__ import annotations

import secrets
import string
from contextlib import contextmanager
from typing import Iterator

import psycopg

from app.config import get_settings

_ALPHABET = string.ascii_lowercase + string.digits


def generate_id() -> str:
    """Collision-resistant id compatible with Prisma's String @id columns."""
    return "c" + "".join(secrets.choice(_ALPHABET) for _ in range(24))


@contextmanager
def get_conn() -> Iterator[psycopg.Connection]:
    settings = get_settings()
    if not settings.database_url:
        raise RuntimeError("DATABASE_URL is not configured for the agent runtime.")
    conn = psycopg.connect(settings.database_url, autocommit=False)
    try:
        yield conn
    finally:
        conn.close()
