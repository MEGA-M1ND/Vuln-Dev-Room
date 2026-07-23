"""Append-only RunArtifact writes (plan, diff, test result, summary, log)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from psycopg.types.json import Json

from app.persistence.db import generate_id, get_conn


def append_artifact(
    run_id: str,
    artifact_type: str,
    title: str,
    *,
    content_text: str | None = None,
    content_json: dict[str, Any] | list[Any] | None = None,
    metadata_json: dict[str, Any] | None = None,
) -> str:
    """Append an artifact with a monotonic per-run sequence. Returns its id.

    Artifacts are append-only; there is no update path.
    """
    now = datetime.now(timezone.utc)
    artifact_id = generate_id()
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT COALESCE(MAX("sequence"), 0) + 1 FROM "RunArtifact" WHERE "runId" = %s',
                (run_id,),
            )
            sequence = cur.fetchone()[0]
            cur.execute(
                """
                INSERT INTO "RunArtifact"
                    ("id","runId","type","title","contentText","contentJson",
                     "metadataJson","sequence","createdAt")
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    artifact_id,
                    run_id,
                    artifact_type,
                    title,
                    content_text,
                    Json(content_json) if content_json is not None else None,
                    Json(metadata_json) if metadata_json is not None else None,
                    sequence,
                    now,
                ),
            )
        conn.commit()
    return artifact_id
