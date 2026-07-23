"""Model-provider abstraction.

The graph never talks to a provider SDK directly — it depends only on this small
interface. That keeps the graph deterministic under test (FakeModel) and lets a
real provider be swapped in without touching orchestration.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class PlanRequest:
    title: str
    description: str
    language: str
    repo_tree: list[str]
    file_excerpts: dict[str, str] = field(default_factory=dict)


@dataclass
class ProposedEdit:
    """A whole-file replacement proposed by the model for one path."""

    path: str
    new_content: str
    rationale: str = ""


@dataclass
class PlanResult:
    plan_text: str
    edits: list[ProposedEdit]
    summary_hint: str = ""


class Model(Protocol):
    name: str

    def propose_change(self, request: PlanRequest) -> PlanResult:
        """Return a human-readable plan plus concrete file edits.

        Implementations MUST NOT perform side effects; they only propose. The
        graph is responsible for applying edits inside the sandbox and for
        respecting the allow-list.
        """
        ...
