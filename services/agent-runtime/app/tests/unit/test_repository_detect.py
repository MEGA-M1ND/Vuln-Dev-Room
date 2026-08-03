import pytest

from app.repository.detect import UnsupportedRepositoryError, detect_language_and_test_command


def test_root_pyproject_toml_detected_as_python():
    language, test_command = detect_language_and_test_command(
        ["pyproject.toml", "src/app.py", "README.md"]
    )
    assert language == "python"
    assert test_command == "pytest -q"


def test_root_requirements_txt_detected_as_python():
    language, _ = detect_language_and_test_command(["requirements.txt", "app.py"])
    assert language == "python"


def test_python_files_without_a_manifest_still_detected():
    language, _ = detect_language_and_test_command(["main.py", "utils.py"])
    assert language == "python"


def test_nested_manifest_does_not_count_as_root_level():
    # A vendored dependency's own pyproject.toml shouldn't make an otherwise
    # non-Python repo look like one.
    with pytest.raises(UnsupportedRepositoryError):
        detect_language_and_test_command(["vendor/some-lib/pyproject.toml", "README.md"])


def test_no_python_markers_raises_unsupported():
    with pytest.raises(UnsupportedRepositoryError):
        detect_language_and_test_command(["package.json", "src/index.js", "README.md"])
