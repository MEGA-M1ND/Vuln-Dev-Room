"""Rough ownership, derived from git history.

"Owner" here means *who has actually touched this code lately*, which is the
only ownership signal that cannot go stale. It is explicitly not authority: a
CODEOWNERS file states policy, this states practice, and where they disagree the
disagreement is itself worth seeing.

Recency-weighted on purpose. Raw commit counts crown whoever did the original
import commit years ago; the person who touched a file last quarter is the one
worth asking.
"""

from __future__ import annotations

import subprocess
from collections import defaultdict
from dataclasses import dataclass, field


@dataclass
class OwnerStat:
    name: str
    email: str
    commits: int
    #: Recency-weighted score; only meaningful relative to other owners.
    score: float = 0.0

    def as_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "email": self.email,
            "commits": self.commits,
            "score": round(self.score, 3),
        }


@dataclass
class FileOwnership:
    path: str
    owners: list[OwnerStat] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {"path": self.path, "owners": [o.as_dict() for o in self.owners]}


def _git_log_authors(
    root: str, path: str, *, max_commits: int, timeout: int
) -> list[tuple[str, str]]:
    """`git log --follow` for one path, newest first.

    argv list, never a shell string: `path` originates from a query and must
    never be interpolated into a command line. `--` terminates option parsing so
    a path that begins with a dash cannot be read as a flag.
    """
    try:
        completed = subprocess.run(
            [
                "git",
                "-C",
                root,
                "log",
                "--follow",
                f"-n{max_commits}",
                "--format=%an%x00%ae",
                "--",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return []

    if completed.returncode != 0:
        return []

    authors: list[tuple[str, str]] = []
    for line in completed.stdout.splitlines():
        if "\x00" not in line:
            continue
        name, _, email = line.partition("\x00")
        name, email = name.strip(), email.strip().lower()
        if email:
            authors.append((name, email))
    return authors


def owners_for_paths(
    root: str,
    paths: list[str],
    *,
    max_paths: int = 40,
    max_commits: int = 50,
    top_n: int = 3,
    timeout: int = 15,
) -> list[FileOwnership]:
    """Resolve likely owners for each path.

    Bounded by `max_paths`: this spawns one `git log` per path, so an unbounded
    list would turn a blast-radius query into hundreds of subprocesses.
    """
    out: list[FileOwnership] = []

    for path in paths[:max_paths]:
        authors = _git_log_authors(
            root, path, max_commits=max_commits, timeout=timeout
        )
        if not authors:
            continue

        commits: dict[str, int] = defaultdict(int)
        weighted: dict[str, float] = defaultdict(float)
        names: dict[str, str] = {}

        for index, (name, email) in enumerate(authors):
            commits[email] += 1
            # Newest commit weighs 1.0 and decays; the exact curve matters less
            # than that recent work outranks a long-ago burst of it.
            weighted[email] += 1.0 / (1.0 + index * 0.35)
            names.setdefault(email, name)

        ranked = sorted(
            (
                OwnerStat(
                    name=names[email],
                    email=email,
                    commits=commits[email],
                    score=weighted[email],
                )
                for email in commits
            ),
            key=lambda stat: (-stat.score, stat.email),
        )
        out.append(FileOwnership(path=path, owners=ranked[:top_n]))

    return out


def has_touched(ownership: list[FileOwnership], email: str) -> bool:
    """Whether `email` appears as an owner anywhere in `ownership`.

    Feature 3 uses this instead of a seniority field: "has this person worked in
    this area before?" is evidence from the repository, where "how senior is
    this person?" would be a self-reported number nobody maintains.
    """
    needle = email.strip().lower()
    if not needle:
        return False
    return any(
        owner.email == needle for entry in ownership for owner in entry.owners
    )
