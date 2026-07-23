"""run_project_tests tool — runs the repository's configured test command only.

The agent cannot choose an arbitrary command: the command comes from the trusted
repository registry, not from the model or the browser.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.sandbox.base import Sandbox
from app.security.redaction import redact


@dataclass
class TestOutcome:
    passed: bool
    exit_code: int
    output: str
    timed_out: bool


def run_project_tests(sandbox: Sandbox, test_command: str) -> TestOutcome:
    result = sandbox.run_tests(test_command)
    combined = redact((result.stdout or "") + ("\n" + result.stderr if result.stderr else ""))
    return TestOutcome(
        passed=result.exit_code == 0 and not result.timed_out,
        exit_code=result.exit_code,
        output=combined.strip(),
        timed_out=result.timed_out,
    )
