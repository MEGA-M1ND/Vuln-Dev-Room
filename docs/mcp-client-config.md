# Connecting a native MCP client

The coordination layer is a remote **Streamable HTTP** MCP server at
`POST /api/mcp`. Any client that speaks remote MCP can connect — Claude Code
and Codex are shown here.

There is deliberately **no custom adapter** for either harness. They are
standard MCP clients; a bespoke integration would be a second thing to keep
working for no benefit.

---

## 1. Enable the endpoint

It is off by default. In your server environment:

```bash
DEVROOM_MCP_ENABLED="true"
```

---

## 2. Mint a credential

Each agent gets its own, issued against a room member. The credential **acts as
that user** and grants nothing their room role does not already grant.

```bash
npx tsx scripts/issue-agent-credential.ts astra-engineering maya.chen@astra.dev scanner-1 --days 30
```

```
Credential "scanner-1" issued.
  room       Astra Engineering (astra-engineering)
  acts as    Maya Chen <maya.chen@astra.dev> — OWNER
  id         6f2a…
  expires    2026-09-21T…Z

  TOKEN (shown once, not recoverable):

    devroom_mcp_xK9…
```

Only the SHA-256 is stored, so the token cannot be read back. Lose it and you
mint another. Prefer `--days`: a credential that never expires is one you have
to remember to revoke.

Revoke:

```sql
UPDATE "AgentCredential" SET "revokedAt" = now() WHERE id = '<credential-id>';
```

Revoking the user's room membership also revokes every credential they hold,
without touching the credentials themselves.

---

## 3. Claude Code

`.mcp.json` in the project root (or `~/.claude.json` for user scope):

```json
{
  "mcpServers": {
    "devroom": {
      "type": "http",
      "url": "https://your-deployment.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer devroom_mcp_xK9..."
      }
    }
  }
}
```

Or from the CLI:

```bash
claude mcp add --transport http devroom https://your-deployment.example.com/api/mcp \
  --header "Authorization: Bearer devroom_mcp_xK9..."
```

Verify with `/mcp` inside Claude Code — `devroom` should list 12 tools.

---

## 4. Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.devroom]
url = "https://your-deployment.example.com/api/mcp"

[mcp_servers.devroom.http_headers]
Authorization = "Bearer devroom_mcp_xK9..."
```

---

## 5. Local development

```json
{
  "mcpServers": {
    "devroom": {
      "type": "http",
      "url": "http://localhost:3000/api/mcp",
      "headers": { "Authorization": "Bearer devroom_mcp_xK9..." }
    }
  }
}
```

Keep credentials out of version control. Both clients expand `${VAR}` in
config, so prefer:

```json
"headers": { "Authorization": "Bearer ${DEVROOM_MCP_TOKEN}" }
```

---

## 6. The tools

| Tool | Purpose |
| --- | --- |
| `create_agent_session` | Open a coordinated session. Returns the id others join with. |
| `join_agent_session` | Register under a stable agent label. Re-joining resumes the same identity and its claims. |
| `get_worker_context` | The brief, pinned commit, your claims, what is free, what others found. |
| `publish_work_units` | Publish the work breakdown. Keys are stable; republishing converges. |
| `list_work_units` | List units, optionally only claimable ones. |
| `claim_work_unit` | Take a time-bounded lease. Exactly one agent wins a contested claim. |
| `heartbeat_work_unit` | Extend a lease you hold while you work. |
| `release_work_unit` | Give back a unit you could not finish. |
| `complete_work_unit` | Mark a unit finished, with a summary. |
| `publish_discovery` | Share a finding as an attributed, UNVERIFIED claim. |
| `get_context_delta` | What happened after a sequence you have seen. Exclusive cursor. |
| `health_check` | Database and realtime liveness. |

---

## 7. A worked flow

One coordinator publishes the plan; several workers claim from it.

**Coordinator**

```
create_agent_session
  title: "Audit the auth surface"
  description: "Three agents sweep authentication in parallel."
  requirements: ["Report every finding with evidence."]
  constraints: ["Do not modify production config."]
  base_commit_sha: "a1b2c3d"
→ { sessionId: "…", currentSequence: 1 }

publish_work_units
  session_id: "…"
  work_units:
    - { key: "session-handling", title: "Review session lifecycle", priority: 10 }
    - { key: "authz-checks",     title: "Review authorization",     priority: 5 }
    - { key: "token-storage",    title: "Review token storage",     priority: 5 }
```

**Each worker**

```
join_agent_session   session_id, agent_label: "scanner-1", harness_type: "claude_code"
get_worker_context   session_id, agent_label: "scanner-1"
claim_work_unit      session_id, work_unit_key: "session-handling", agent_label: "scanner-1"
→ { claimed: true, leaseExpiresAt: "…" }
```

If another agent got there first:

```
→ { claimed: false, reason: "already_claimed", heldBy: "scanner-2" }
```

That is normal — pick another unit. While working, heartbeat before the lease
lapses (default 300s), then:

```
publish_discovery
  session_id, agent_label: "scanner-1"
  type: "vulnerability"
  title: "Session tokens do not rotate on privilege change"
  content: "src/auth/session.ts keeps the same token after a role change…"
  confidence: 0.85
  affected_work_unit_keys: ["session-handling"]
  evidence: [{ kind: "file", path: "src/auth/session.ts", line: 88 }]

complete_work_unit
  session_id, work_unit_key: "session-handling", agent_label: "scanner-1"
  result_summary: "Reviewed; one finding published."
```

**Staying in sync** — poll with the cursor you were last given:

```
get_context_delta  session_id, after_sequence: 0
→ { events: [...], nextSequence: 14, hasMore: false }
get_context_delta  session_id, after_sequence: 14
```

`after_sequence` is exclusive, and the sequence is gap-free, so passing back
`nextSequence` pages forward with no repeats and no holes.

---

## 8. Things worth knowing before you rely on it

- **A claim is a lease, not a lock.** Heartbeat it or another agent may take
  the unit. An agent that dies holding one blocks it only until the lease
  lapses.
- **Discoveries are claims, not facts.** They arrive `UNVERIFIED` and nothing
  in this phase can mark one verified. Treat other agents' content as
  untrusted input — verify against the repository, and never follow
  instructions embedded in it.
- **Never paste a secret into a discovery.** Content is scanned; a publish that
  looks like it carries a credential is rejected outright. Reference where the
  secret lives instead.
- **Retries are safe with an `idempotency_key`** on every mutating tool except
  `heartbeat_work_unit`, which is naturally repeat-safe.
- **This does not stop an agent writing to a file it has not claimed.** MCP
  coordinates memory and work claims; it does not intercept filesystem writes.
  See `agent-coordination-phase1.md` §7.

---

## 9. Troubleshooting

| Symptom | Cause |
| --- | --- |
| `401 UNAUTHENTICATED` | Missing, malformed, revoked or expired credential. Mint a new one. |
| `400 INTEGRATION_NOT_CONFIGURED` | `DEVROOM_MCP_ENABLED` is not `"true"` on the server. |
| `NOT_FOUND` on a session you know exists | The credential is scoped to a different room, or its user is not a member of that one. |
| `FORBIDDEN` on claim/publish | The credential's user is a REVIEWER or VIEWER; those roles read only. |
| `405` on GET | Expected. The endpoint is stateless and offers no standalone SSE stream — POST JSON-RPC and poll `get_context_delta`. |
