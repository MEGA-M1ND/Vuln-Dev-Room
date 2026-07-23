"""Deterministic model double.

This is an EXPLICIT test double (not a stand-in that fabricates results). It
performs a fully deterministic, inspectable transformation so that unit tests,
integration tests, and offline demos produce a *real* diff and *real* test
output — never faked success.

Rule: for each provided file excerpt, it replaces the first line of the form

    raise NotImplementedError  # devroom:implement <EXPRESSION>

with

    return <EXPRESSION>

preserving indentation. Files without a marker are left unchanged. This lets the
fixture repository ship a genuinely failing test that becomes genuinely passing
only after the agent applies the edit inside the sandbox.
"""

from __future__ import annotations

import re

from app.models.base import Model, PlanRequest, PlanResult, ProposedEdit

_MARKER = re.compile(
    r"^(?P<indent>[ \t]*)raise\s+NotImplementedError\b.*#\s*devroom:implement\s+(?P<expr>.+?)\s*$"
)


class FakeModel(Model):
    name = "fake-deterministic"

    def propose_change(self, request: PlanRequest) -> PlanResult:
        edits: list[ProposedEdit] = []
        touched: list[str] = []

        for path, content in sorted(request.file_excerpts.items()):
            new_lines: list[str] = []
            changed = False
            for line in content.splitlines():
                m = _MARKER.match(line)
                if m and not changed:
                    indent = m.group("indent")
                    expr = m.group("expr")
                    new_lines.append(f"{indent}return {expr}")
                    changed = True
                else:
                    new_lines.append(line)
            if changed:
                # Preserve a trailing newline if the original had one.
                trailing = "\n" if content.endswith("\n") else ""
                edits.append(
                    ProposedEdit(
                        path=path,
                        new_content="\n".join(new_lines) + trailing,
                        rationale=f"Implemented the marked stub in {path}.",
                    )
                )
                touched.append(path)

        if edits:
            plan = (
                f"Address ticket: {request.title}\n\n"
                "Approach:\n"
                f"1. Inspect the {request.language} repository.\n"
                "2. Locate stubbed implementations marked with "
                "`# devroom:implement`.\n"
                f"3. Implement {len(edits)} function(s) in: "
                f"{', '.join(touched)}.\n"
                "4. Run the project test suite to verify.\n"
            )
            summary = (
                f"Implemented {len(edits)} stubbed function(s) "
                f"({', '.join(touched)}) and verified via the test suite."
            )
        else:
            plan = (
                f"Address ticket: {request.title}\n\n"
                "Inspected the repository but found no actionable "
                "`# devroom:implement` markers within the allowed paths, so no "
                "edits were proposed."
            )
            summary = "No actionable markers were found; no changes were made."

        return PlanResult(plan_text=plan, edits=edits, summary_hint=summary)
