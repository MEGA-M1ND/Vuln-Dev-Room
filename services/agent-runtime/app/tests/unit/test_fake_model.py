from app.models.base import PlanRequest
from app.models.fake_model import FakeModel


def test_fake_model_implements_marked_stub():
    content = (
        "def allow(self):\n"
        "    raise NotImplementedError  # devroom:implement self._consume()\n"
    )
    result = FakeModel().propose_change(
        PlanRequest(
            title="t",
            description="d",
            language="python",
            repo_tree=["backend/x.py"],
            file_excerpts={"backend/x.py": content},
        )
    )
    assert len(result.edits) == 1
    edit = result.edits[0]
    assert edit.path == "backend/x.py"
    assert "return self._consume()" in edit.new_content
    assert "raise NotImplementedError" not in edit.new_content
    assert result.plan_text
    assert result.summary_hint


def test_fake_model_is_deterministic():
    req = PlanRequest(
        title="t",
        description="d",
        language="python",
        repo_tree=["a.py"],
        file_excerpts={"a.py": "    raise NotImplementedError  # devroom:implement 42\n"},
    )
    first = FakeModel().propose_change(req)
    second = FakeModel().propose_change(req)
    assert first.edits[0].new_content == second.edits[0].new_content


def test_fake_model_no_marker_makes_no_edits():
    result = FakeModel().propose_change(
        PlanRequest(
            title="t",
            description="d",
            language="python",
            repo_tree=["a.py"],
            file_excerpts={"a.py": "print('hello')\n"},
        )
    )
    assert result.edits == []
    assert "no actionable" in result.plan_text.lower()
