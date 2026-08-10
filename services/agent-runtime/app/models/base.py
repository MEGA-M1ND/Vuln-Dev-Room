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


@dataclass
class ImpactSummaryRequest:
    """Everything needed to describe a blast radius in plain language.

    `audience` is the requester's room role (OWNER / ENGINEER / VIEWER /
    REVIEWER). It tunes depth, not content: the same facts are reported to
    everyone, because a summary that omitted a risk for a senior reader would be
    a summary that hid it.
    """

    query: str
    seeds: list[str]
    affected_paths: list[str]
    critical_paths: list[str]
    api_endpoints: list[str]
    owners: list[str] = field(default_factory=list)
    audience: str = "ENGINEER"
    truncated: bool = False


def render_default_impact_summary(request: ImpactSummaryRequest) -> str:
    """Deterministic, provider-free impact summary.

    Used as the protocol default and as FakeModel's answer, so the whole
    blast-radius feature is demoable and testable with no model credentials.
    """
    reach = len(request.affected_paths)
    newcomer = request.audience == "VIEWER"

    lines: list[str] = []
    if reach == 0:
        lines.append(
            f"Nothing in the repository imports {request.query}, so a change there "
            "looks self-contained."
        )
        return " ".join(lines)

    lines.append(
        f"Changing {request.query} reaches {reach} file{'s' if reach != 1 else ''}."
    )
    if newcomer:
        lines.append(
            "That count is everything that imports it directly or indirectly — "
            "those are the places most likely to break."
        )

    if request.critical_paths:
        joined = ", ".join(request.critical_paths)
        lines.append(
            f"It touches paths this team marked critical ({joined}), so expect review."
        )
    if request.api_endpoints:
        joined = ", ".join(request.api_endpoints[:5])
        lines.append(f"API surface affected: {joined}.")
        if newcomer:
            lines.append("Changes there are visible to callers outside this repo.")
    if request.owners:
        joined = ", ".join(request.owners[:3])
        lines.append(f"Recent work here is by {joined} — worth a heads-up.")
    if request.truncated:
        lines.append(
            "The walk hit its bound, so this is a partial view; treat the count "
            "as a floor, not a total."
        )
    return " ".join(lines)


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

    def summarize_impact(self, request: ImpactSummaryRequest) -> str:
        """Describe a blast radius in plain language (blast-radius query).

        Defaulted rather than required: this arrived after the protocol was in
        use, and a provider that has not implemented it should degrade to a
        factual summary, not crash a query. The default states only what the
        static analysis actually found — it never speculates about intent,
        because a confident sentence about consequences nobody verified is worse
        than a plain list of facts.
        """
        return render_default_impact_summary(request)
