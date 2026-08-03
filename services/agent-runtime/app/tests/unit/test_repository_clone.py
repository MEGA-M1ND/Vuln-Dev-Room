"""Phase 1c cloning. These don't touch the network or Docker: a local bare git
repo stands in for "a remote" and exercises the exact same `git clone` /
`git checkout` code path a real github.com HTTPS URL would."""

from __future__ import annotations

import os
import subprocess

import pytest

from app.repository.clone import (
    RepositorySourceError,
    clone_repository,
    github_https_url,
    list_tracked_files,
)


@pytest.fixture
def bare_remote(tmp_path):
    """A local repo with two commits, exposed as a plain path "remote"."""
    work = tmp_path / "work"
    work.mkdir()
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "Test",
        "GIT_AUTHOR_EMAIL": "test@example.com",
        "GIT_COMMITTER_NAME": "Test",
        "GIT_COMMITTER_EMAIL": "test@example.com",
    }
    # Pin the branch name explicitly so this test doesn't depend on the host's
    # git init.defaultBranch config.
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=work, check=True, env=env)
    (work / "a.py").write_text("print('first')\n")
    subprocess.run(["git", "add", "-A"], cwd=work, check=True, env=env)
    subprocess.run(["git", "commit", "-q", "-m", "first"], cwd=work, check=True, env=env)
    first_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=work, check=True, env=env, capture_output=True, text=True
    ).stdout.strip()

    (work / "a.py").write_text("print('second')\n")
    subprocess.run(["git", "add", "-A"], cwd=work, check=True, env=env)
    subprocess.run(["git", "commit", "-q", "-m", "second"], cwd=work, check=True, env=env)
    second_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=work, check=True, env=env, capture_output=True, text=True
    ).stdout.strip()

    return {"path": str(work), "first_sha": first_sha, "second_sha": second_sha}


def test_github_https_url_builds_from_owner_and_repo():
    assert (
        github_https_url("octocat", "hello-world")
        == "https://github.com/octocat/hello-world.git"
    )


@pytest.mark.parametrize(
    "owner,repo",
    [
        ("../../etc", "passwd"),
        ("octocat", "../../etc/passwd"),
        ("octo cat", "repo"),
        ("octocat", "repo; rm -rf /"),
        ("", "repo"),
    ],
)
def test_github_https_url_rejects_unsafe_segments(owner, repo):
    with pytest.raises(RepositorySourceError):
        github_https_url(owner, repo)


def test_clone_without_pin_gets_current_head_of_ref(bare_remote):
    cloned = clone_repository(
        bare_remote["path"], ref="main", pinned_sha=None, timeout=30
    )
    try:
        assert cloned.revision == bare_remote["second_sha"]
        assert (open(f"{cloned.path}/a.py").read()) == "print('second')\n"
    finally:
        import shutil

        shutil.rmtree(cloned.path, ignore_errors=True)


def test_clone_with_pinned_sha_checks_out_that_exact_commit(bare_remote):
    cloned = clone_repository(
        bare_remote["path"],
        ref="main",
        pinned_sha=bare_remote["first_sha"],
        timeout=30,
    )
    try:
        assert cloned.revision == bare_remote["first_sha"]
        assert (open(f"{cloned.path}/a.py").read()) == "print('first')\n"
    finally:
        import shutil

        shutil.rmtree(cloned.path, ignore_errors=True)


def test_clone_failure_raises_repository_source_error(tmp_path):
    with pytest.raises(RepositorySourceError):
        clone_repository(str(tmp_path / "does-not-exist"), ref="main", pinned_sha=None, timeout=10)


def test_list_tracked_files_reflects_the_checked_out_commit(bare_remote):
    cloned = clone_repository(
        bare_remote["path"], ref="main", pinned_sha=None, timeout=30
    )
    try:
        assert list_tracked_files(cloned.path) == ["a.py"]
    finally:
        import shutil

        shutil.rmtree(cloned.path, ignore_errors=True)
