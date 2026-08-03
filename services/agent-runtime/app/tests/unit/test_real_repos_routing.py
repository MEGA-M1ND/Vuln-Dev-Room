"""Phase 1c: routes._resolve_repo prefers a room's connected GitHub repo over
the static demo registry, but only when the feature flag is on and a
connection actually exists — otherwise behavior is byte-for-byte what it was
before this phase existed."""

from __future__ import annotations

import json

import pytest

from app.api.routes import _resolve_repo
from app.config import Settings
from app.persistence import repositories as repositories_db
from app.repository.clone import RepositorySourceError


def _settings(*, real_repos_enabled: bool) -> Settings:
    return Settings(
        DEVROOM_REAL_REPOS_ENABLED=real_repos_enabled,
        DEVROOM_REPOSITORIES_JSON=json.dumps(
            {
                "agentguard-demo": {
                    "display_name": "AgentGuard demo",
                    "source_path": "/srv/agentguard-demo",
                }
            }
        ),
    )


def test_flag_off_uses_static_registry_even_with_a_connection(monkeypatch):
    monkeypatch.setattr(
        repositories_db,
        "get_active_repository_connection",
        lambda room_id: pytest.fail("must not be queried when the flag is off"),
    )
    repo = _resolve_repo({"roomId": "room-1"}, "agentguard-demo", _settings(real_repos_enabled=False))
    assert repo is not None
    assert repo.source_path == "/srv/agentguard-demo"
    assert repo.git_url is None


def test_flag_on_no_connection_falls_back_to_static_registry(monkeypatch):
    monkeypatch.setattr(
        repositories_db, "get_active_repository_connection", lambda room_id: None
    )
    repo = _resolve_repo({"roomId": "room-1"}, "agentguard-demo", _settings(real_repos_enabled=True))
    assert repo is not None
    assert repo.source_path == "/srv/agentguard-demo"


def test_flag_on_with_connection_ignores_the_static_key(monkeypatch):
    from app.persistence.repositories import RepositoryConnectionRow

    monkeypatch.setattr(
        repositories_db,
        "get_active_repository_connection",
        lambda room_id: RepositoryConnectionRow(
            owner="octocat", repo="hello-world", default_branch="main"
        ),
    )
    repo = _resolve_repo({"roomId": "room-1"}, "agentguard-demo", _settings(real_repos_enabled=True))
    assert repo is not None
    assert repo.source_path is None
    assert repo.git_url == "https://github.com/octocat/hello-world.git"
    assert repo.git_ref == "main"


def test_invalid_connection_owner_raises_instead_of_building_a_bad_url(monkeypatch):
    from app.persistence.repositories import RepositoryConnectionRow

    monkeypatch.setattr(
        repositories_db,
        "get_active_repository_connection",
        lambda room_id: RepositoryConnectionRow(
            owner="../../etc", repo="passwd", default_branch="main"
        ),
    )
    with pytest.raises(RepositorySourceError):
        _resolve_repo({"roomId": "room-1"}, "agentguard-demo", _settings(real_repos_enabled=True))
