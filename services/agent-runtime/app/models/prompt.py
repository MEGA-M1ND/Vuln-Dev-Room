"""Shared prompt text and response parsing for real model providers."""

from __future__ import annotations

import json

SYSTEM = (
    "You are backend-agent, a careful backend coding assistant. You are given a "
    "ticket and excerpts from a repository. Propose a minimal change as STRICT "
    "JSON with keys: plan (string), summary (string), edits (array of {path, "
    "new_content, rationale}). Only edit files that were provided to you. Return "
    "the FULL new content for each edited file. Respond with JSON only."
)


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
