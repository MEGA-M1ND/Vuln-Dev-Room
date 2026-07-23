"""Internal service-to-service authentication.

Only the Next.js server (which holds the shared token) may call `/internal/*`.
Browsers never receive this token. Uses a constant-time comparison.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from app.config import get_settings


def require_service_token(
    authorization: str | None = Header(default=None),
    x_internal_token: str | None = Header(default=None, alias="X-Internal-Token"),
) -> None:
    settings = get_settings()
    expected = settings.agent_service_token

    if not expected:
        # Fail closed: if the runtime has no token configured, it cannot be
        # called at all rather than accepting everyone.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service authentication is not configured.",
        )

    provided = x_internal_token
    if provided is None and authorization and authorization.startswith("Bearer "):
        provided = authorization[len("Bearer ") :]

    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing internal service token.",
        )
