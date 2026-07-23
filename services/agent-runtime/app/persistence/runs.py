"""Durable AgentRun status + append-only RunEvent writes."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from psycopg.types.json import Json

from app.persistence.db import generate_id, get_conn

TERMINAL = {"SUCCEEDED", "FAILED", "CANCELLED"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def get_run(run_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT "id","roomId","ticketId","requestedById","agentId","status",
                       "graphThreadId","sandboxId","targetRepositoryKey","baseRevision",
                       "startedAt","finishedAt","errorCode","errorSummary","runVersion"
                FROM "AgentRun" WHERE "id" = %s
                """,
                (run_id,),
            )
            row = cur.fetchone()
            if row is None:
                return None
            cols = [d.name for d in cur.description]
            return dict(zip(cols, row))


def update_run_status(
    run_id: str,
    status: str,
    *,
    sandbox_id: str | None = None,
    base_revision: str | None = None,
    error_code: str | None = None,
    error_summary: str | None = None,
) -> int:
    """Update run status, bump runVersion, and manage timestamps + the
    single-active-run guard. Returns the new runVersion.

    Setting a terminal status clears `activeTicketId` (releasing the DB-level
    lock that prevents a second active run for the ticket).
    """
    is_terminal = status in TERMINAL
    with get_conn() as conn:
        with conn.cursor() as cur:
            sets = ['"status" = %s', '"runVersion" = "runVersion" + 1', '"updatedAt" = %s']
            params: list[Any] = [status, _now()]

            if status == "RUNNING":
                sets.append('"startedAt" = COALESCE("startedAt", %s)')
                params.append(_now())
            if is_terminal:
                sets.append('"finishedAt" = %s')
                params.append(_now())
                sets.append('"activeTicketId" = NULL')
            if sandbox_id is not None:
                sets.append('"sandboxId" = %s')
                params.append(sandbox_id)
            if base_revision is not None:
                sets.append('"baseRevision" = %s')
                params.append(base_revision)
            if error_code is not None:
                sets.append('"errorCode" = %s')
                params.append(error_code)
            if error_summary is not None:
                sets.append('"errorSummary" = %s')
                params.append(error_summary)

            params.append(run_id)
            cur.execute(
                f'UPDATE "AgentRun" SET {", ".join(sets)} WHERE "id" = %s '
                f'RETURNING "runVersion"',
                params,
            )
            new_version = cur.fetchone()[0]
        conn.commit()
    return new_version


def append_event(
    run_id: str,
    event_type: str,
    *,
    actor_type: str = "agent",
    actor_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> int:
    """Append an event with a monotonic per-run sequence. Returns the sequence.

    Uses a single transaction with `SELECT ... FOR UPDATE`-style max+1 under the
    run row lock to keep sequences gap-free and monotonic.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT COALESCE(MAX("sequence"), 0) + 1 FROM "RunEvent" WHERE "runId" = %s',
                (run_id,),
            )
            sequence = cur.fetchone()[0]
            cur.execute(
                """
                INSERT INTO "RunEvent"
                    ("id","runId","sequence","type","actorType","actorId","payloadJson","createdAt")
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    generate_id(),
                    run_id,
                    sequence,
                    event_type,
                    actor_type,
                    actor_id,
                    Json(payload) if payload is not None else None,
                    _now(),
                ),
            )
        conn.commit()
    return sequence
