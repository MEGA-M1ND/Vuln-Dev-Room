"""Prompt fragments for the backend agent.

Kept centralized for auditability. The FakeModel ignores these (it is
deterministic); the configured model uses its own strict-JSON system prompt in
`models/configured_model.py`. These fragments describe the agent's remit and are
reused when constructing a plan artifact.
"""

BACKEND_AGENT_ROLE = (
    "backend-agent inspects a configured repository snapshot inside an isolated "
    "sandbox, plans a minimal change to satisfy a task, edits only allow-listed "
    "files, and runs the project's own test suite to verify. It never accesses the "
    "network, the host filesystem, or any credentials."
)

# Phase 1b: bounded iterative comprehension. The planner may issue up to this
# many search/read_file/list_repository tool calls before it must emit a plan
# — replaces the old one-shot dump of up to 12 files into the first prompt.
MAX_PLANNING_TOOL_CALLS = 8
MAX_FILE_BYTES = 20_000
