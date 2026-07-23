"""Real model provider (Anthropic-compatible), plus the model factory.

The configured model is used only when a provider + API key are set. It asks the
model for a strict JSON object describing a plan and whole-file edits, then parses
it. If anything is missing or malformed it raises — it never silently fabricates
a result.
"""

from __future__ import annotations

import json

from app.config import Settings
from app.models.base import Model, PlanRequest, PlanResult, ProposedEdit
from app.models.fake_model import FakeModel

_SYSTEM = (
    "You are backend-agent, a careful backend coding assistant. You are given a "
    "ticket and excerpts from a repository. Propose a minimal change as STRICT "
    "JSON with keys: plan (string), summary (string), edits (array of {path, "
    "new_content, rationale}). Only edit files that were provided to you. Return "
    "the FULL new content for each edited file. Respond with JSON only."
)


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


def _parse_json(text: str) -> dict:
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
    raise RuntimeError(f"Unknown model provider: {settings.model_provider!r}")
