"""Real model provider (Anthropic-compatible), plus the model factory.

The configured model is used only when a provider + API key are set. It asks the
model for a strict JSON object describing a plan and whole-file edits, then parses
it. If anything is missing or malformed it raises — it never silently fabricates
a result.
"""

from __future__ import annotations

import json

from app.config import Settings
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
from app.models.fake_model import FakeModel
from app.models.openai_model import OpenAIModel
from app.models.prompt import EXPLORE_SYSTEM as _EXPLORE_SYSTEM
from app.models.prompt import REVIEW_SYSTEM as _REVIEW_SYSTEM
from app.models.prompt import SYSTEM as _SYSTEM
from app.models.prompt import decision_to_tool_call as _decision_to_tool_call
from app.models.prompt import parse_json_response as _parse_json
from app.models.prompt import render_exploration_prompt as _render_exploration
from app.models.prompt import render_review_prompt as _render_review


class ConfiguredModel(Model):
    def __init__(self, model_name: str, api_key: str) -> None:
        try:
            import anthropic  # noqa: F401
        except ImportError as exc:  # pragma: no cover - env dependent
            raise RuntimeError(
                "The 'anthropic' package is required for the configured model. "
                "Install with: pip install '.[anthropic]'"
            ) from exc
        self._anthropic = __import__("anthropic")
        self.name = model_name
        self._client = self._anthropic.Anthropic(api_key=api_key)

    def next_tool_call(
        self, request: PlanRequest, history: list[tuple[ToolCall, str]]
    ) -> ToolCall | None:
        message = self._client.messages.create(
            model=self.name,
            max_tokens=256,
            system=_EXPLORE_SYSTEM,
            messages=[
                {"role": "user", "content": _render_exploration(request, history)}
            ],
        )
        text = "".join(
            block.text for block in message.content if getattr(block, "type", "") == "text"
        )
        return _decision_to_tool_call(text)

    def propose_change(self, request: PlanRequest) -> PlanResult:
        excerpts = "\n\n".join(
            f"### FILE: {path}\n```\n{content}\n```"
            for path, content in sorted(request.file_excerpts.items())
        )
        user = (
            f"Ticket title: {request.title}\n"
            f"Ticket description: {request.description}\n"
            f"Language: {request.language}\n\n"
            f"Repository files (tree):\n{json.dumps(request.repo_tree, indent=2)}\n\n"
            f"File excerpts:\n{excerpts}\n"
        )
        message = self._client.messages.create(
            model=self.name,
            max_tokens=4096,
            system=_SYSTEM,
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(
            block.text for block in message.content if getattr(block, "type", "") == "text"
        )
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
        message = self._client.messages.create(
            model=self.name,
            max_tokens=2048,
            system=_REVIEW_SYSTEM,
            messages=[{"role": "user", "content": _render_review(request)}],
        )
        text = "".join(
            block.text for block in message.content if getattr(block, "type", "") == "text"
        )
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


def build_model(settings: Settings) -> Model:
    """Select the model implementation from configuration."""
    provider = settings.model_provider.lower()
    if provider in ("fake", "", "none"):
        return FakeModel()
    if provider == "anthropic":
        if not settings.anthropic_api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is required for provider=anthropic.")
        model_name = settings.model_name or "claude-opus-4-8"
        return ConfiguredModel(model_name=model_name, api_key=settings.anthropic_api_key)
    if provider == "openai":
        if not settings.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY is required for provider=openai.")
        model_name = settings.model_name or "gpt-5.2"
        return OpenAIModel(model_name=model_name, api_key=settings.openai_api_key)
    raise RuntimeError(f"Unknown model provider: {settings.model_provider!r}")
