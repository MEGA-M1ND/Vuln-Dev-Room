import pytest

from app.security.paths import (
    PathNotAllowedError,
    assert_allowed,
    matches_allowed,
    normalize_relative,
)


def test_normalize_rejects_absolute_and_traversal():
    with pytest.raises(PathNotAllowedError):
        normalize_relative("/etc/passwd")
    with pytest.raises(PathNotAllowedError):
        normalize_relative("../secrets")
    with pytest.raises(PathNotAllowedError):
        normalize_relative("backend/../../etc/passwd")
    with pytest.raises(PathNotAllowedError):
        normalize_relative("")
    with pytest.raises(PathNotAllowedError):
        normalize_relative(".")


def test_normalize_collapses_clean_paths():
    assert normalize_relative("backend/./app.py") == "backend/app.py"
    assert normalize_relative("backend//app.py") == "backend/app.py"


def test_matches_allowed_globs():
    allowed = ["backend/**", "tests/**"]
    assert matches_allowed("backend/app.py", allowed)
    assert matches_allowed("backend/sub/deep.py", allowed)
    assert matches_allowed("tests/test_app.py", allowed)
    assert not matches_allowed("frontend/index.tsx", allowed)
    assert not matches_allowed("secrets.env", allowed)


def test_assert_allowed_enforces_list():
    allowed = ["backend/**"]
    assert assert_allowed("backend/x.py", allowed) == "backend/x.py"
    with pytest.raises(PathNotAllowedError):
        assert_allowed("infra/deploy.sh", allowed)
    # Traversal attempts that would escape are rejected before glob matching.
    with pytest.raises(PathNotAllowedError):
        assert_allowed("backend/../infra/x", allowed)
