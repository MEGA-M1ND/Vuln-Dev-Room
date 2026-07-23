from app.config import Settings


def test_repository_registry_parses_and_hides_nothing_extra():
    raw = (
        '{"demo": {"display_name": "Demo", "source_path": "/srv/demo", '
        '"allowed_paths": ["backend/**", ""], "test_command": "pytest -q", '
        '"language": "python"}}'
    )
    settings = Settings(DEVROOM_REPOSITORIES_JSON=raw, DATABASE_URL="postgresql://x/y")
    repos = settings.repositories
    assert "demo" in repos
    assert repos["demo"].source_path == "/srv/demo"
    # Empty globs are filtered out.
    assert repos["demo"].allowed_paths == ["backend/**"]


def test_unknown_repository_key_returns_none():
    settings = Settings(DEVROOM_REPOSITORIES_JSON="{}")
    assert settings.repository("does-not-exist") is None


def test_langgraph_url_defaults_to_app_db():
    settings = Settings(DATABASE_URL="postgresql://app/db")
    assert settings.effective_langgraph_url == "postgresql://app/db"
    settings2 = Settings(
        DATABASE_URL="postgresql://app/db",
        DEVROOM_LANGGRAPH_DATABASE_URL="postgresql://lg/db",
    )
    assert settings2.effective_langgraph_url == "postgresql://lg/db"
