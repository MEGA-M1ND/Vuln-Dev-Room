import pytest

from app.sandbox.base import SandboxUnavailableError
from app.sandbox.docker_sandbox import ensure_docker_available


@pytest.fixture(scope="session")
def docker_required() -> None:
    """Skip Docker-dependent tests when no daemon is reachable."""
    try:
        ensure_docker_available()
    except SandboxUnavailableError as exc:
        pytest.skip(f"Docker not available: {exc}")
