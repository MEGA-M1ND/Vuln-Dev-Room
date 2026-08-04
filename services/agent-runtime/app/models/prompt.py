"""Shared prompt text and response parsing for real model providers."""

from __future__ import annotations

import json

from app.models.base import PlanRequest, ReviewRequest, ToolCall

SYSTEM = (
    "You are backend-agent, a careful backend coding assistant. You are given a "
    "ticket and excerpts from a repository. Propose a minimal change as STRICT "
    "JSON with keys: plan (string), summary (string), edits (array of {path, "
    "new_content, rationale}). Only edit files that were provided to you. Return "
    "the FULL new content for each edited file. Respond with JSON only."
)

# Phase 1b: the exploration turn that runs before SYSTEM/propose_change. The
# model chooses read-only tool calls to build up file_excerpts for itself
# instead of receiving a blind pre-selected file dump.
EXPLORE_SYSTEM = (
    "You are backend-agent, deciding what to inspect in a repository before "
    "proposing a change. You may request a limited number of read-only tool "
    "calls: read_file (a specific path), search_repository (a text query), or "
    "list_repository (the file tree again). Respond with STRICT JSON: "
    '{"action": "read_file" | "search_repository" | "list_repository" | '
    '"done", "path": string (read_file only), "query": string '
    "(search_repository only)}. Choose \"done\" as soon as you have enough "
    "context — usually after reading the handful of files most relevant to the "
    "ticket — to propose a minimal, correct change. Respond with JSON only."
)


# Phase 5: reviewer-agent reads another run's already-captured plan, diff and
# test result — it never touches the sandbox or repository itself.
REVIEW_SYSTEM = (
    "You are reviewer-agent, reviewing a completed change made by another "
    "agent. You are given the ticket, the plan that was proposed, the diff "
    "that was applied, and the captured test result. Respond with STRICT "
    'JSON: {"summary": string, "verdict": "approve" | "request_changes" | '
    '"comment", "comments": array of {"path": string, "severity": "info" | '
    '"suggestion" | "concern", "comment": string}}. Use "request_changes" '
    "only for a genuine problem (e.g. failing tests, a change that "
    "contradicts the plan); otherwise \"approve\". path may be empty for a "
    "run-level remark. Respond with JSON only."
)


def render_review_prompt(request: ReviewRequest) -> str:
    return (
        f"Proposed plan (states the ticket it addresses):\n{request.plan_text}\n\n"
        f"Applied diff:\n{request.diff_text}\n\n"
        f"Test result (passed={request.test_passed}):\n{request.test_output}\n"
    )


def render_exploration_prompt(
    request: PlanRequest, history: list[tuple[ToolCall, str]]
) -> str:
    lines = [
        f"Ticket title: {request.title}",
        f"Ticket description: {request.description}",
        f"Language: {request.language}",
        "",
        f"Repository files (tree):\n{json.dumps(request.repo_tree, indent=2)}",
        "",
    ]
    if history:
        lines.append("Tool calls made so far, in order:")
        for call, result in history:
            lines.append(f"- {call.tool}({call.args}) ->\n{result[:2000]}")
    else:
        lines.append("No tool calls have been made yet.")
    return "\n".join(lines)


def decision_to_tool_call(text: str) -> ToolCall | None:
    """Parse an exploration-turn JSON response into the next tool call, or
    None if the model chose "done"."""
    data = parse_json_response(text)
    action = str(data.get("action", "done")).strip().lower()
    if action == "read_file":
        return ToolCall(tool="read_file", args={"path": str(data.get("path", ""))})
    if action == "search_repository":
        return ToolCall(
            tool="search_repository", args={"query": str(data.get("query", ""))}
        )
    if action == "list_repository":
        return ToolCall(tool="list_repository", args={})
    return None


def parse_json_response(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        # Strip a ```json ... ``` fence if present.
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[len("json") :]
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        raise RuntimeError("Model did not return a JSON object.")
    return json.loads(text[start : end + 1])
