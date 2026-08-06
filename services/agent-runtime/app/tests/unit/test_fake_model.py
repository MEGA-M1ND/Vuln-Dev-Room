from app.models.base import PlanRequest, ReviewRequest
from app.models.fake_model import FakeModel

_DIFF = (
    "diff --git a/foo.py b/foo.py\n"
    "index 1111111..2222222 100644\n"
    "--- a/foo.py\n"
    "+++ b/foo.py\n"
    "@@ -1 +1 @@\n"
    "-old\n"
    "+new\n"
)


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


def test_fake_model_review_approves_a_passing_diff():
    result = FakeModel().review(
        ReviewRequest(
            plan_text="Address task: t\n",
            diff_text=_DIFF,
            test_output="1 passed",
            test_passed=True,
        )
    )
    assert result.verdict == "approve"
    assert [c.path for c in result.comments] == ["foo.py"]
    assert all(c.severity == "info" for c in result.comments)


def test_fake_model_review_requests_changes_on_a_failing_test_run():
    result = FakeModel().review(
        ReviewRequest(
            plan_text="Address task: t\n",
            diff_text=_DIFF,
            test_output="1 failed",
            test_passed=False,
        )
    )
    assert result.verdict == "request_changes"
    concerns = [c for c in result.comments if c.severity == "concern"]
    assert len(concerns) == 1
    assert "fail" in concerns[0].comment.lower()


def test_fake_model_review_of_empty_diff_is_a_comment_not_an_approval():
    result = FakeModel().review(
        ReviewRequest(plan_text="p", diff_text="", test_output="", test_passed=None)
    )
    assert result.verdict == "comment"
    assert result.comments == []


def test_fake_model_review_is_deterministic():
    req = ReviewRequest(
        plan_text="p", diff_text=_DIFF, test_output="1 passed", test_passed=True
    )
    first = FakeModel().review(req)
    second = FakeModel().review(req)
    assert first == second
