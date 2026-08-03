"""Read-only access to a room's connected GitHub repository.

Phase 1c: rather than trusting anything the web app passes about which repo
to use, the runtime looks this up itself from the same Prisma-owned tables it
already reads AgentRun/RunEvent from — the room id on the durable run row is
the only thing that needs to be trusted.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.persistence.db import get_conn


@dataclass
class RepositoryConnectionRow:
    owner: str
    repo: str
    default_branch: str


def get_active_repository_connection(room_id: str) -> RepositoryConnectionRow | None:
    """The room's most recently connected active repository, if any.

    A room can have more than one RepositoryConnection row (e.g. a previous
    connection deactivated and replaced); the most recently created active one
    wins, mirroring "the room's current connected repo" as shown in the UI.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT "owner", "repo", "defaultBranch"
                FROM "RepositoryConnection"
                WHERE "roomId" = %s AND "isActive" = true
                ORDER BY "createdAt" DESC
                LIMIT 1
                """,
                (room_id,),
            )
            row = cur.fetchone()
            if row is None:
                return None
            return RepositoryConnectionRow(owner=row[0], repo=row[1], default_branch=row[2])
