"""Shared FastAPI dependencies."""

from __future__ import annotations

from app.config import Settings, get_settings


def settings_dependency() -> Settings:
    return get_settings()
