# AgentGuard demo repository

A deterministic fixture repository for Dev Room Stage 2 agent runs. The
`backend/rate_limiter.py` module contains a stubbed method marked with
`# devroom:implement` and a matching failing test. The backend-agent implements
the stub inside the sandbox, turning the failing test green.
