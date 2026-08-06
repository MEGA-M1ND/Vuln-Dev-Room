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


@dataclass
class ReviewRequest:
    """What reviewer-agent sees of the run it is reviewing (roadmap Phase 5).

    No task title/description: AgentRun rows don't persist them (only the
    AgentTask does, and the task context is already embedded in `plan_text` —
    every Model.propose_change() implementation opens its plan with the
    task it addressed), so reviewer-agent works from what the source run
    itself durably captured rather than a second round trip to fetch it.
    """

    plan_text: str
    diff_text: str
    test_output: str
    test_passed: bool | None


@dataclass
class ReviewComment:
    """One review remark. `path` is empty for a run-level (not file-level)
    remark, e.g. a failing test suite."""

    path: str
    severity: str  # "info" | "suggestion" | "concern"
    comment: str


@dataclass
class ReviewResult:
    summary: str
    verdict: str  # "approve" | "request_changes" | "comment"
    comments: list[ReviewComment] = field(default_factory=list)


@dataclass
class ToolCall:
    """A single repository-exploration call the planner wants to make.

    `tool` is one of "list_repository", "read_file", "search_repository" — the
    same read-only operations already exposed by `app.tools.repository.Toolset`.
    The graph executes it and feeds the result back via `next_tool_call`; the
    model itself never touches the sandbox.
    """

    tool: str
    args: dict[str, str] = field(default_factory=dict)


class Model(Protocol):
    name: str

    def propose_change(self, request: PlanRequest) -> PlanResult:
        """Return a human-readable plan plus concrete file edits.

        Implementations MUST NOT perform side effects; they only propose. The
        graph is responsible for applying edits inside the sandbox and for
        respecting the allow-list.
        """
        ...

    def next_tool_call(
        self, request: PlanRequest, history: list[tuple[ToolCall, str]]
    ) -> ToolCall | None:
        """Optional iterative-comprehension hook.

        Called by the planner, in a loop bounded by
        `app.graph.prompts.MAX_PLANNING_TOOL_CALLS`, before `propose_change`.
        `request.file_excerpts` accumulates the results of prior `read_file`
        calls; `history` is every (call, result) pair made so far this run, in
        order. Return the next call to make, or `None` once there is enough
        context to plan.

        The default implementation never explores — a model that doesn't
        override this goes straight to `propose_change` exactly as before this
        hook was added.
        """
        return None

    def review(self, request: ReviewRequest) -> ReviewResult:
        """Review another run's plan, diff and test result (roadmap Phase 5:
        reviewer-agent). Read-only — no side effects, no repository access;
        everything it needs is already captured on the run being reviewed.
        """
        ...
