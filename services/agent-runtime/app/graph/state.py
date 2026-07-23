"""LangGraph state.

Only JSON-serializable data lives here so it can be checkpointed. Non-serializable
runtime objects (sandbox, toolset, model, DB writers) are injected via a closure
`RunContext`, never stored in state.
"""

from __future__ import annotations

from typing import Any, TypedDict


class AgentState(TypedDict, total=False):
    run_id: str
    ticket_title: str
    ticket_description: str
    language: str
    allowed_paths: list[str]

    base_revision: str
    repo_tree: list[str]
    excerpts: dict[str, str]

    plan_text: str
    proposed_edits: list[dict[str, Any]]  # {path, new_content, rationale}
    applied_paths: list[str]

    tests_passed: bool
    tests_output: str
    tests_exit_code: int

    diff_text: str
    summary_text: str

    error_code: str
    error_summary: str
