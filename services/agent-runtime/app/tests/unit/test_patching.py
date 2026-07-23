import pytest

from app.sandbox.base import PatchResult
from app.security.paths import PathNotAllowedError
from app.tools.patching import apply_patch
from app.tools.repository import Toolset


class StubSandbox:
    """Minimal in-memory sandbox double for testing the allow-list gate."""

    sandbox_id = "stub"

    def __init__(self) -> None:
        self.written: dict[str, str] = {}

    def apply_patch(self, rel_path: str, new_content: str) -> PatchResult:
        created = rel_path not in self.written
        self.written[rel_path] = new_content
        return PatchResult(path=rel_path, applied=True, created=created)


def test_apply_patch_allows_listed_path():
    sb = StubSandbox()
    result = apply_patch(sb, ["backend/**"], "backend/app.py", "x = 1\n")
    assert result.path == "backend/app.py"
    assert sb.written["backend/app.py"] == "x = 1\n"


def test_apply_patch_rejects_unlisted_path():
    sb = StubSandbox()
    with pytest.raises(PathNotAllowedError):
        apply_patch(sb, ["backend/**"], "infra/deploy.sh", "rm -rf /\n")
    assert sb.written == {}  # nothing was written


def test_apply_patch_rejects_traversal():
    sb = StubSandbox()
    with pytest.raises(PathNotAllowedError):
        apply_patch(sb, ["backend/**"], "backend/../../etc/passwd", "bad")
    assert sb.written == {}


def test_toolset_is_allowed():
    ts = Toolset(sandbox=StubSandbox(), allowed_paths=["backend/**"], test_command="pytest")
    assert ts.is_allowed("backend/x.py")
    assert not ts.is_allowed("frontend/x.tsx")
