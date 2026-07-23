"""FastAPI application entrypoint for the Dev Room agent runtime."""

from __future__ import annotations

from fastapi import FastAPI

from app.api.routes import router

app = FastAPI(
    title="Dev Room Agent Runtime",
    version="0.1.0",
    description="Internal sandboxed LangGraph backend-agent runtime (Stage 2).",
)

app.include_router(router)


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "devroom-agent-runtime", "status": "ok"}
