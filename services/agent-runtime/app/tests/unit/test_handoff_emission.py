"""A successful run emits a structured handoff, built from what it actually did.

`_record_handoff` has no I/O of its own — it only calls `recorder.event(...)` —
so it is testable in isolation from the sandbox, Postgres, and the rest of the
graph. The web side that turns this event into a durable `HandoffCard` is
covered by the TypeScript integration suite (`tests/integration/handoffs.test.ts`),
since that half of the flow lives entirely on the web app.
"""

from __future__ import annotations

from typing import Any

from app.graph.backend_agent import _record_handoff


class FakeRecorder:
    """Captures events instead of writing to Postgres."""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any] | None]] = []

    def event(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        self.events.append((event_type, payload))

    def artifact(self, *args: Any, **kwargs: Any) -> None:
        raise AssertionError("_record_handoff must not write artifacts")


def test_emits_handoff_prepared_with_the_actual_summary_and_test_result():
    recorder = FakeRecorder()
    final_state = {
        "summary_text": "Fixed the session-expiry bug. All tests passed.",
        "tests_passed": True,
        "tests_exit_code": 0,
    }

    _record_handoff(recorder, final_state)  # type: ignore[arg-type]

    assert len(recorder.events) == 1
    event_type, payload = recorder.events[0]
    assert event_type == "HANDOFF_PREPARED"
    assert payload["summary"] == "Fixed the session-expiry bug. All tests passed."
    assert payload["testsRun"] == {"passed": True, "exitCode": 0}
    assert payload["openQuestions"] == []


def test_reports_a_failed_test_run_rather_than_hiding_it():
    recorder = FakeRecorder()
    final_state = {
        "summary_text": "Attempted the fix.",
        "tests_passed": False,
        "tests_exit_code": 1,
    }

    _record_handoff(recorder, final_state)  # type: ignore[arg-type]

    _, payload = recorder.events[0]
    assert payload["testsRun"]["passed"] is False
    assert payload["testsRun"]["exitCode"] == 1


def test_missing_exit_code_is_omitted_rather_than_sent_as_null():
    # The web contract types exitCode as an optional integer; sending `null`
    # would fail that validation rather than simply omitting an unknown value.
    recorder = FakeRecorder()
    final_state = {"summary_text": "No changes were required.", "tests_passed": False}

    _record_handoff(recorder, final_state)  # type: ignore[arg-type]

    _, payload = recorder.events[0]
    assert "exitCode" not in payload["testsRun"]


def test_fires_even_when_no_changes_were_applied():
    # "Nothing needed to change" is itself information the next person should
    # get explicitly, not silence they have to interpret.
    recorder = FakeRecorder()
    final_state = {"summary_text": "No changes were required.", "tests_passed": False}

    _record_handoff(recorder, final_state)  # type: ignore[arg-type]

    assert recorder.events[0][0] == "HANDOFF_PREPARED"
