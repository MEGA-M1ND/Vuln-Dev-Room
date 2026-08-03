"""Runtime configuration.

All configuration comes from the environment. The most security-sensitive values
(the repository registry with host `source_path`s, the internal service token,
the model API key) live ONLY here on the agent-runtime host and are never sent to
browsers.
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class RepositoryConfig(BaseModel):
    """A repository the agent may work against.

    Either a static, host-only `source_path` (the demo registry — unchanged
    since Stage 2) or a `git_url`/`git_ref` pair (Phase 1c: a room's connected
    GitHub repository). Never both, never neither. When `git_url` is set, the
    orchestrator clones it on the runtime host (which has network, unlike the
    agent sandbox) before handing a local directory to `Sandbox.prepare_repository`
    exactly as today — nothing downstream of that point knows the difference.
    """

    display_name: str
    source_path: str | None = None
    git_url: str | None = None
    git_ref: str = "HEAD"
    allowed_paths: list[str] = Field(default_factory=list)
    test_command: str = "pytest -q"
    language: str = "python"

    @field_validator("allowed_paths")
    @classmethod
    def _non_empty_globs(cls, v: list[str]) -> list[str]:
        return [g.strip() for g in v if g.strip()]

    @model_validator(mode="after")
    def _exactly_one_source(self) -> "RepositoryConfig":
        if bool(self.source_path) == bool(self.git_url):
            raise ValueError(
                "RepositoryConfig requires exactly one of source_path or git_url."
            )
        return self


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DEVROOM_", extra="ignore")

    # Internal service-to-service shared secret. Required to call /internal/*.
    agent_service_token: str = Field(default="", alias="DEVROOM_AGENT_SERVICE_TOKEN")

    # Postgres connection for the Prisma-owned app DB (runs/artifacts/events).
    database_url: str = Field(default="", alias="DATABASE_URL")

    # LangGraph checkpoint storage. Defaults to the app DB but pinned to the
    # dedicated `langgraph` schema so checkpoint tables never collide with app
    # tables. Overridable independently.
    langgraph_database_url: str = Field(default="", alias="DEVROOM_LANGGRAPH_DATABASE_URL")

    # Docker image used for the sandbox. In a normal environment this is a
    # public base like `python:3.11-slim`; in restricted environments a locally
    # built image name can be supplied.
    sandbox_image: str = Field(default="python:3.11-slim", alias="DEVROOM_SANDBOX_IMAGE")

    # Sandbox resource limits.
    sandbox_memory: str = Field(default="512m", alias="DEVROOM_SANDBOX_MEMORY")
    sandbox_cpus: str = Field(default="1.0", alias="DEVROOM_SANDBOX_CPUS")
    sandbox_pids_limit: int = Field(default=256, alias="DEVROOM_SANDBOX_PIDS_LIMIT")
    sandbox_command_timeout: int = Field(default=120, alias="DEVROOM_SANDBOX_TIMEOUT")
    # Dependency installation (network-enabled setup phase) gets a longer
    # budget than an in-sandbox command — package downloads can be slow.
    sandbox_setup_timeout: int = Field(
        default=300, alias="DEVROOM_SANDBOX_SETUP_TIMEOUT"
    )
    # Phase 1a: a network-enabled setup phase that installs a repo's own
    # declared dependencies (requirements.txt/pyproject.toml) before the
    # network-isolated agent phase begins. Off by default so existing
    # deployments are unaffected until this has been validated in CI/staging;
    # inert anyway for any repo with no manifest (e.g. the bundled demo).
    dependency_setup_enabled: bool = Field(
        default=False, alias="DEVROOM_DEPENDENCY_SETUP_ENABLED"
    )

    # Model selection. When no key is configured the deterministic FakeModel is
    # used, which is what unit/integration tests rely on.
    model_provider: str = Field(default="fake", alias="DEVROOM_MODEL_PROVIDER")
    model_name: str = Field(default="", alias="DEVROOM_MODEL_NAME")
    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")

    # Raw JSON registry of repositories.
    repositories_json: str = Field(default="{}", alias="DEVROOM_REPOSITORIES_JSON")

    # Phase 1c: prefer a room's connected GitHub repository (cloned fresh per
    # run) over the static registry above. Off by default — every repo
    # currently configured via DEVROOM_REPOSITORIES_JSON is unaffected until
    # this is deliberately turned on.
    real_repos_enabled: bool = Field(default=False, alias="DEVROOM_REAL_REPOS_ENABLED")
    # Bound on how long a clone may take before the run fails with CLONE_FAILED.
    clone_timeout: int = Field(default=120, alias="DEVROOM_CLONE_TIMEOUT")

    # Stage 3: base URL of the Next.js web app. The runtime calls its internal
    # callback so the web app can broadcast realtime run updates to the room.
    web_callback_url: str = Field(default="", alias="DEVROOM_WEB_CALLBACK_URL")

    @property
    def repositories(self) -> dict[str, RepositoryConfig]:
        raw: dict[str, Any] = json.loads(self.repositories_json or "{}")
        return {key: RepositoryConfig(**value) for key, value in raw.items()}

    def repository(self, key: str) -> RepositoryConfig | None:
        return self.repositories.get(key)

    @property
    def effective_langgraph_url(self) -> str:
        if self.langgraph_database_url:
            return self.langgraph_database_url
        return self.database_url


@lru_cache
def get_settings() -> Settings:
    return Settings()
