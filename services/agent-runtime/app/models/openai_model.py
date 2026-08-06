"""OpenAI-backed model provider."""

from __future__ import annotations

from app.models.base import (
    Model,
    PlanRequest,
    PlanResult,
    ProposedEdit,
    ReviewComment,
    ReviewRequest,
    ReviewResult,
    ToolCall,
)
from app.models.prompt import EXPLORE_SYSTEM as _EXPLORE_SYSTEM
from app.models.prompt import REVIEW_SYSTEM as _REVIEW_SYSTEM
from app.models.prompt import SYSTEM as _SYSTEM
from app.models.prompt import decision_to_tool_call as _decision_to_tool_call
from app.models.prompt import parse_json_response as _parse_json
from app.models.prompt import render_exploration_prompt as _render_exploration
from app.models.prompt import render_review_prompt as _render_review


class OpenAIModel(Model):
    def __init__(self, model_name: str, api_key: str) -> None:
        try:
            import openai  # noqa: F401
        except ImportError as exc:  # pragma: no cover - env dependent
            raise RuntimeError(
                "The 'openai' package is required for the configured model. "
                "Install with: pip install '.[openai]'"
            ) from exc
        self.name = model_name
        self._client = __import__("openai").OpenAI(api_key=api_key)

    def next_tool_call(
        self, request: PlanRequest, history: list[tuple[ToolCall, str]]
    ) -> ToolCall | None:
        response = self._client.chat.completions.create(
            model=self.name,
            messages=[
                {"role": "system", "content": _EXPLORE_SYSTEM},
                {"role": "user", "content": _render_exploration(request, history)},
            ],
        )
        text = response.choices[0].message.content or ""
        return _decision_to_tool_call(text)

    def propose_change(self, request: PlanRequest) -> PlanResult:
        import json

        excerpts = "\n\n".join(
            f"### FILE: {path}\n```\n{content}\n```"
            for path, content in sorted(request.file_excerpts.items())
        )
        user = (
            f"AgentTask title: {request.title}\n"
            f"AgentTask description: {request.description}\n"
            f"Language: {request.language}\n\n"
            f"Repository files (tree):\n{json.dumps(request.repo_tree, indent=2)}\n\n"
            f"File excerpts:\n{excerpts}\n"
        )
        response = self._client.chat.completions.create(
            model=self.name,
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": user},
            ],
        )
        text = response.choices[0].message.content or ""
        data = _parse_json(text)
        edits = [
            ProposedEdit(
                path=str(e["path"]),
                new_content=str(e["new_content"]),
                rationale=str(e.get("rationale", "")),
            )
            for e in data.get("edits", [])
        ]
        return PlanResult(
            plan_text=str(data.get("plan", "")),
            edits=edits,
            summary_hint=str(data.get("summary", "")),
        )

    def review(self, request: ReviewRequest) -> ReviewResult:
        response = self._client.chat.completions.create(
            model=self.name,
            messages=[
                {"role": "system", "content": _REVIEW_SYSTEM},
                {"role": "user", "content": _render_review(request)},
            ],
        )
        text = response.choices[0].message.content or ""
        data = _parse_json(text)
        comments = [
            ReviewComment(
                path=str(c.get("path", "")),
                severity=str(c.get("severity", "info")),
                comment=str(c.get("comment", "")),
            )
            for c in data.get("comments", [])
        ]
        return ReviewResult(
            summary=str(data.get("summary", "")),
            verdict=str(data.get("verdict", "comment")),
            comments=comments,
        )
