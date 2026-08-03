import os

from app.sandbox.setup import detect_install_command


def test_no_manifest_means_no_setup(tmp_path):
    assert detect_install_command(str(tmp_path)) is None


def test_requirements_txt_selects_pip_dash_r(tmp_path):
    (tmp_path / "requirements.txt").write_text("six==1.16.0\n")

    cmd = detect_install_command(str(tmp_path))

    assert cmd is not None
    assert cmd[:2] == ["pip", "install"]
    assert cmd[-2:] == ["-r", "requirements.txt"]


def test_pyproject_toml_selects_editable_install(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'x'\n")

    cmd = detect_install_command(str(tmp_path))

    assert cmd is not None
    assert cmd[:2] == ["pip", "install"]
    assert cmd[-2:] == ["-e", "."]


def test_requirements_txt_takes_priority_over_pyproject(tmp_path):
    (tmp_path / "requirements.txt").write_text("six==1.16.0\n")
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'x'\n")

    cmd = detect_install_command(str(tmp_path))

    assert cmd is not None and cmd[-2:] == ["-r", "requirements.txt"]


def test_command_never_interpolates_file_contents(tmp_path):
    """The manifest's *contents* must never leak into the argv — only its
    presence (by filename) selects one of a fixed set of commands."""
    malicious = "; rm -rf / #\nrequests==2.31.0\n"
    (tmp_path / "requirements.txt").write_text(malicious)

    cmd = detect_install_command(str(tmp_path))

    assert cmd is not None
    assert all(malicious not in part for part in cmd)
    # Every element is a fixed literal from the allowlist, not derived text.
    assert cmd == [
        "pip",
        "install",
        "--user",
        "--no-input",
        "--no-cache-dir",
        "-r",
        "requirements.txt",
    ]


def test_directory_named_requirements_txt_is_not_a_manifest(tmp_path):
    # os.path.isfile guards against a same-named directory being mistaken
    # for a manifest.
    os.makedirs(tmp_path / "requirements.txt")

    assert detect_install_command(str(tmp_path)) is None
