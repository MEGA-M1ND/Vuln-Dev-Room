"""OpenAI-backed model provider."""

from __future__ import annotations

from app.models.base import Model, PlanRequest, PlanResult, ProposedEdit
from app.models.prompt import SYSTEM as _SYSTEM
from app.models.prompt import parse_json_response as _parse_json


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

    def propose_change(self, request: PlanRequest) -> PlanResult:
        import json

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
