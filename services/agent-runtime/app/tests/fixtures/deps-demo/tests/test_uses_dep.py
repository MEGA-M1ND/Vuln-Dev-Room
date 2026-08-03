from backend.uses_dep import describe


def test_describe_reports_six_version():
    assert describe().startswith("six version: ")
