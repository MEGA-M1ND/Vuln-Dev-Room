import os
import re

# Fields resolved via code, not meant to be set directly in .env.example.
_COMPUTED = set()


def _runtime_root() -> str:
    # __file__ is app/tests/unit/test_env_example.py; three levels up is the
    # agent-runtime service root (where .env.example and pyproject.toml live).
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))


def _read(relative: str) -> str:
    with open(os.path.join(_runtime_root(), relative), encoding="utf-8") as f:
        return f.read()


def test_env_example_documents_every_settings_alias():
    """Settings.Field(alias=...) is the runtime's only source of truth for
    which env vars it reads. A new field added there without a matching entry
    in .env.example fails silently until it's missing in some real
    deployment — the exact class of bug that cost real time diagnosing an
    undocumented AUTH_GITHUB_ID on the web app's side of this project."""
    config_source = _read("app/config.py")
    aliases = set(re.findall(r'alias="([A-Z][A-Z0-9_]*)"', config_source))
    assert len(aliases) > 5  # guard against the regex matching nothing

    documented = set()
    for line in _read(".env.example").split("\n"):
        match = re.match(r"^\s*#?\s*([A-Z][A-Z0-9_]*)=", line)
        if match:
            documented.add(match.group(1))

    missing = aliases - documented - _COMPUTED
    assert not missing, f"Undocumented in services/agent-runtime/.env.example: {sorted(missing)}"
