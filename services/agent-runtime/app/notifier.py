"""Realtime notifier.

After a run's status or event changes, the runtime pings the web app's internal
callback so it can broadcast a lightweight `RUN_UPDATED` signal to the room over
Liveblocks. This is best-effort: the durable truth is always in Postgres, so a
failed notification never affects a run (clients still see the change on their
next fetch/poll). Mirrors the Stage 1 "broadcast = invalidation signal" pattern.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from app.config import Settings


@dataclass
class Notifier:
    settings: Settings
    run_id: str
    room_id: str

    @property
    def _enabled(self) -> bool:
        return bool(self.settings.web_callback_url and self.settings.agent_service_token)

    def notify(self, *, status: str | None = None, event_type: str | None = None) -> None:
        if not self._enabled:
            return
        url = f"{self.settings.web_callback_url.rstrip('/')}/api/internal/agent-callback"
        try:
            httpx.post(
                url,
                json={
                    "runId": self.run_id,
                    "roomId": self.room_id,
                    "status": status,
                    "eventType": event_type,
                },
                headers={"X-Internal-Token": self.settings.agent_service_token},
                timeout=3.0,
            )
        except Exception as exc:  # noqa: BLE001 - best effort, never fail a run
            print(f"[notifier] callback failed (ignored): {exc}")


class NullNotifier:
    """No-op notifier for tests / when the web callback is unconfigured."""

    def notify(self, *, status: str | None = None, event_type: str | None = None) -> None:
        return
