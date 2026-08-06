// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { prisma } from "@/lib/db/client";
import { ingestAgentEvents } from "@/lib/agent/ingest";
import { agentEventSchema } from "@/contracts/agent-events";
import { computeRoomSignals } from "@/lib/agent/signals";
// The adapter is plain ESM with no dependency on the app; importing it here is
// exactly how a consumer would. Types come from its own .d.ts, which is
// self-contained — the adapter folder must stay copy-pasteable into another
// repository.
import {
  mapHookEvent,
  redactCommand,
  relativePath,
} from "../../adapters/claude-code/map-hook-event.mjs";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `cc-${Date.now()}`;
const CFG = { taskId: "task_123", provider: "claude_code", model: "claude-opus-5" };

function hook(fields: Record<string, unknown>) {
  return { session_id: "sess_abc", cwd: "/home/dev/project", ...fields };
}

/**
 * Map and assert an event was produced. Tests that expect an event should fail
 * loudly on `null` rather than dereferencing it, so a mapping that silently
 * stops emitting is caught here and not in production.
 */
function mapped(hookPayload: Parameters<typeof mapHookEvent>[0], config = CFG) {
  const event = mapHookEvent(hookPayload, config);
  expect(event, "expected the adapter to emit an event").not.toBeNull();
  return event!;
}

describe("Claude Code adapter — mapping", () => {
  it("reports a session start", () => {
    const e = mapped(
      hook({ hook_event_name: "SessionStart", source: "startup" }),
    );
    expect(e.eventType).toBe("agent_started");
    expect(e.agent).toMatchObject({ provider: "claude_code", sessionId: "sess_abc" });
  });

  it("groups every event of a session under Claude Code's own session id", () => {
    const a = mapped(hook({ hook_event_name: "SessionStart" }));
    const b = mapped(hook({ hook_event_name: "Stop", session_id: "sess_abc" }));
    expect(a.agent.sessionId).toBe(b.agent.sessionId);
  });

  it("records what the human asked for", () => {
    const e = mapped(
      hook({ hook_event_name: "UserPromptSubmit", prompt: "Add rate limiting to /login" }),
    );
    expect(e.eventType).toBe("instruction_added");
    expect(e.payload.summary).toBe("Add rate limiting to /login");
  });

  it("reports edited files as repo-relative paths, never absolute", () => {
    const e = mapped(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/home/dev/project/src/auth/session.ts" },
      }),
    );
    expect(e.eventType).toBe("file_touched");
    expect(e.payload.files).toEqual(["src/auth/session.ts"]);
    // A developer's home directory never reaches a shared timeline.
    expect(JSON.stringify(e)).not.toContain("/home/dev");
  });

  it("collects every path from a batched edit, without duplicates", () => {
    const e = mapped(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "MultiEdit",
        tool_input: {
          edits: [
            { file_path: "/home/dev/project/a.ts" },
            { file_path: "/home/dev/project/b.ts" },
            { file_path: "/home/dev/project/a.ts" },
          ],
        },
      }),
    );
    expect(e.payload.files).toEqual(["a.ts", "b.ts"]);
  });

  it("never sends file contents, only paths", () => {
    const e = mapped(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: "/home/dev/project/secrets.ts",
          content: "const APP_SECRET = 'hunter2';",
        },
      }),
    );
    expect(JSON.stringify(e)).not.toContain("hunter2");
    expect(e.payload.files).toEqual(["secrets.ts"]);
  });

  it("distinguishes a test run from an ordinary command", () => {
    const test = mapped(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm test -- --run" },
        tool_response: { exit_code: 0 },
      }),
    );
    expect(test.eventType).toBe("test_completed");
    expect(test.payload.status).toBe("passed");

    const cmd = mapped(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
        tool_response: { exit_code: 0 },
      }),
    );
    expect(cmd.eventType).toBe("command_executed");
  });

  it("says it does not know rather than claiming a test passed", () => {
    const e = mapped(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "pytest" },
        tool_response: {},
      }),
    );
    expect(e.payload.status).toBeUndefined();
    expect(String(e.payload.summary)).toMatch(/could not determine/i);
  });

  it("maps a non-zero exit to failed", () => {
    const e = mapped(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "vitest run" },
        tool_response: { exit_code: 1 },
      }),
    );
    expect(e.payload.status).toBe("failed");
  });

  it("turns 'Claude Code needs you' into the waiting-for-input state", () => {
    const e = mapped(
      hook({ hook_event_name: "Notification", message: "Claude needs your permission" }),
    );
    expect(e.eventType).toBe("status_changed");
    expect(e.payload.to).toBe("waiting_for_input");
  });

  it("never claims success when the agent merely stops", () => {
    for (const name of ["Stop", "SessionEnd"]) {
      const e = mapped(hook({ hook_event_name: name }));
      expect(e.eventType).toBe("agent_progress");
      // The contract forbids an adapter claiming success; assert we do not try.
      expect(e.payload.to).toBeUndefined();
      expect(JSON.stringify(e)).not.toMatch(/succeeded|review_ready/i);
    }
  });

  it("stays quiet about reads, searches and other internal tool use", () => {
    for (const tool of ["Read", "Grep", "Glob", "WebFetch", "TodoWrite"]) {
      expect(
        mapHookEvent(
          hook({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: {} }),
          CFG,
        ),
      ).toBeNull();
    }
  });

  it("refuses to emit anything without a task or a session", () => {
    expect(mapHookEvent(hook({ hook_event_name: "SessionStart" }), { taskId: "" })).toBeNull();
    expect(
      mapHookEvent({ hook_event_name: "SessionStart", session_id: undefined }, CFG),
    ).toBeNull();
    expect(mapHookEvent(null, CFG)).toBeNull();
  });

  it("emits events that satisfy the published contract", () => {
    const hooks = [
      { hook_event_name: "SessionStart" },
      { hook_event_name: "UserPromptSubmit", prompt: "do the thing" },
      {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/home/dev/project/x.ts" },
      },
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_response: { exit_code: 0 },
      },
      { hook_event_name: "Notification", message: "waiting" },
      { hook_event_name: "Stop" },
    ];
    for (const h of hooks) {
      const event = mapped(hook(h));
      // Throws if the adapter ever drifts from the contract.
      expect(() => agentEventSchema.parse(event)).not.toThrow();
    }
  });
});

describe("Claude Code adapter — secret redaction", () => {
  it("redacts credentials assigned in a command", () => {
    const out = redactCommand(
      "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 && npm run deploy",
    );
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(out).toContain("npm run deploy");
  });

  it("redacts well-known credential shapes anywhere they appear", () => {
    const samples = [
      "curl -H 'x: ghp_abcdefghijklmnopqrstuvwxyz012345'",
      "echo github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
      "openai --key sk-abcdefghijklmnopqrstuvwxyz",
      "slack xoxb-1234567890-abcdefg",
      "aws AKIAIOSFODNN7EXAMPLE",
    ];
    for (const s of samples) {
      const out = redactCommand(s);
      expect(out).toContain("[redacted]");
    }
  });

  it("redacts secrets passed as flags and in URLs", () => {
    expect(redactCommand("gh auth login --token supersecretvalue")).not.toContain(
      "supersecretvalue",
    );
    expect(redactCommand("git push https://user:pa55word@github.com/a/b")).not.toContain(
      "pa55word",
    );
    expect(
      redactCommand("curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9'"),
    ).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("leaves ordinary commands intact", () => {
    const cmd = "npm run build && git commit -m 'fix the parser'";
    expect(redactCommand(cmd)).toBe(cmd);
  });

  it("redaction runs before an event leaves the mapper", () => {
    const e = mapped(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "DEPLOY_SECRET=abc123xyz ./deploy.sh" },
        tool_response: { exit_code: 0 },
      }),
    );
    expect(JSON.stringify(e)).not.toContain("abc123xyz");
  });
});

describe("Claude Code adapter — path handling", () => {
  it("relativizes under cwd and leaves outside paths alone", () => {
    expect(relativePath("/a/b/src/x.ts", "/a/b")).toBe("src/x.ts");
    expect(relativePath("/other/x.ts", "/a/b")).toBe("/other/x.ts");
    expect(relativePath("/a/b", "/a/b")).toBeNull();
    expect(relativePath("", "/a/b")).toBeNull();
  });

  it("does not treat a sibling directory as a prefix match", () => {
    // "/a/ب-other" must not be mistaken for a child of "/a/b".
    expect(relativePath("/a/bother/x.ts", "/a/b")).toBe("/a/bother/x.ts");
  });
});

// --- the real thing: adapter output, through real ingestion ----------------

describe.skipIf(!hasDb)("Claude Code adapter — end to end through ingestion", () => {
  let roomId = "";
  let taskId = "";
  let userId = "";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: "Adapter User", email: `adapter-${suffix}@test.local` },
    });
    userId = user.id;
    const room = await prisma.room.create({
      data: {
        name: "Adapter Room",
        slug: `adapter-room-${suffix}`,
        createdById: user.id,
        memberships: { create: [{ userId: user.id, role: "OWNER" }] },
      },
    });
    roomId = room.id;
    const task = await prisma.agentTask.create({
      data: { roomId, title: "Add rate limiting", createdById: user.id, position: 1000 },
    });
    taskId = task.id;
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("turns a realistic Claude Code session into one coherent run", async () => {
    const session = [
      { hook_event_name: "SessionStart", source: "startup" },
      { hook_event_name: "UserPromptSubmit", prompt: "Add rate limiting to /login" },
      {
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/home/dev/project/src/auth/login.ts" },
      },
      {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/home/dev/project/src/auth/login.ts" },
      },
      {
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/home/dev/project/src/auth/rate-limit.ts" },
      },
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm test -- src/auth" },
        tool_response: { exit_code: 0 },
      },
      { hook_event_name: "Notification", message: "Claude needs your permission to push" },
      { hook_event_name: "Stop" },
    ];

    // Not `mapped()` here: this session deliberately includes a Read, which
    // the adapter is supposed to drop. Filtering is the assertion.
    const events = session
      .map((h) => mapHookEvent(hook({ ...h, session_id: `sess-${suffix}` }), { ...CFG, taskId }))
      .filter((e) => e !== null);

    // The Read is dropped; everything else is reported.
    expect(events).toHaveLength(7);

    const result = await ingestAgentEvents(events);
    expect(result.accepted).toBe(7);
    expect(result.duplicates).toBe(0);

    const runIds = [...new Set(result.results.map((r) => r.runId))];
    expect(runIds).toHaveLength(1);

    const run = await prisma.agentRun.findUniqueOrThrow({
      where: { id: runIds[0]! },
      include: { events: { orderBy: { sequence: "asc" } } },
    });

    // The Notification landed the run in the state the control room sorts up.
    expect(run.status).toBe("WAITING_FOR_INPUT");
    expect(run.agentSessionId).toBe(`sess-${suffix}`);
    expect(run.taskId).toBe(taskId);

    // Ordering is server-assigned and monotonic.
    const sequences = run.events.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);

    expect(run.events.map((e) => e.type)).toContain("AGENT_STARTED");
    expect(run.events.map((e) => e.type)).toContain("FILE_PATCHED");
  });

  it("refuses a second concurrent Claude Code session on the same task", async () => {
    // Pointing two sessions at one task is a real mistake an adapter user can
    // make, and "one active run per task" is enforced in the database. The
    // adapter does not get to bypass it.
    await expect(
      ingestAgentEvents([
        mapped(hook({ hook_event_name: "SessionStart", session_id: `second-${suffix}` }), {
          ...CFG,
          taskId,
        }),
      ]),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_ACTIVE" });
  });

  it("is safe to replay — a retried session writes nothing new", async () => {
    const replayTask = await prisma.agentTask.create({
      data: { roomId, title: "Replay", createdById: userId, position: 2000 },
    });
    const session = [
      { hook_event_name: "SessionStart" },
      {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/home/dev/project/src/replay.ts" },
      },
    ];
    const events = session.map((h) =>
      mapped(hook({ ...h, session_id: `replay-${suffix}` }), {
        ...CFG,
        taskId: replayTask.id,
      }),
    );

    const first = await ingestAgentEvents(events);
    const second = await ingestAgentEvents(events);

    expect(first.accepted).toBe(2);
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(2);
  });

  it("feeds the risk signals — an adapter's files are seen like any other agent's", async () => {
    // The whole promise of the contract: work reported by an external agent is
    // treated exactly like the built-in runtime's. Two tasks touching the same
    // file must raise an overlap regardless of which agent touched it.
    const overlapTask = await prisma.agentTask.create({
      data: { roomId, title: "Also edits login", createdById: userId, position: 3000 },
    });
    await ingestAgentEvents([
      mapped(
        hook({
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          // The same file the first session edited, on a different task.
          tool_input: { file_path: "/home/dev/project/src/auth/login.ts" },
          session_id: `overlap-${suffix}`,
        }),
        { ...CFG, taskId: overlapTask.id },
      ),
    ]);

    const signals = await computeRoomSignals(roomId);
    const overlap = signals.filter((s) => s.kind === "overlapping_work");
    expect(overlap.length).toBeGreaterThan(0);
    expect(overlap.flatMap((s) => s.evidence).join(" ")).toContain(
      "src/auth/login.ts",
    );
  });
});
