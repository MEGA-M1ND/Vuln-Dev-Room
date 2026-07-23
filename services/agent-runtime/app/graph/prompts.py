"""Prompt fragments for the backend agent.

Kept centralized for auditability. The FakeModel ignores these (it is
deterministic); the configured model uses its own strict-JSON system prompt in
`models/configured_model.py`. These fragments describe the agent's remit and are
reused when constructing a plan artifact.
"""

BACKEND_AGENT_ROLE = (
    "backend-agent inspects a configured repository snapshot inside an isolated "
    "sandbox, plans a minimal change to satisfy a ticket, edits only allow-listed "
    "files, and runs the project's own test suite to verify. It never accesses the "
    "network, the host filesystem, or any credentials."
)

# How many files (matching the allow-list) to pull into the model context.
MAX_INSPECTED_FILES = 12
MAX_FILE_BYTES = 20_000
