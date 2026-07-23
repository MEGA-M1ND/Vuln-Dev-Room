"""Secret redaction for anything that may be surfaced to users.

Test output and logs from the sandbox are captured verbatim, then passed through
this redactor before being stored as artifacts, so an accidental secret in the
environment or output never lands in a browser-visible artifact.
"""

from __future__ import annotations

import re

# Patterns for common secret shapes. Conservative — favors over-redaction.
_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"(?i)(api[_-]?key|secret|token|password|passwd|authorization)\s*[:=]\s*\S+"),
    re.compile(r"sk-[A-Za-z0-9]{16,}"),  # provider-style keys
    re.compile(r"AKIA[0-9A-Z]{16}"),  # AWS access key id
    re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),  # JWT
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]

_REDACTED = "[REDACTED]"


def redact(text: str | None) -> str:
    if not text:
        return ""
    out = text
    for pattern in _PATTERNS:
        out = pattern.sub(_REDACTED, out)
    return out
