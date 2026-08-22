// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The session-cookie fallback path. `signedInUserId` steers what `auth()`
 * returns, so the same endpoint can be exercised as an anonymous caller, a
 * signed-in human, and a bearer-credential agent.
 */
let signedInUserId: string | null = null;

vi.mock("@/auth", () => ({
  auth: vi.fn(async () =>
    signedInUserId
      ? { user: { id: signedInUserId, name: "Test", email: "t@test.local" } }
      : null,
  ),
}));

vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  // The endpoint is off by default; these tests are about what it does when a
  // deployment has turned it on.
  return { ...actual, isMcpEnabled: true };
});

import { prisma } from "@/lib/db/client";
import { POST, GET } from "@/app/api/mcp/route";
import { issueAgentCredential } from "@/lib/mcp/credentials";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `mcp-${Date.now()}`;

const PROTOCOL_VERSION = "2025-06-18";

/** Build a JSON-RPC request the way a native MCP client would. */
function rpc(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Streamable HTTP requires the client to accept both.
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  },
};

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  // A stateless server with enableJsonResponse answers with plain JSON; parse
  // defensively in case a future change switches it to SSE framing.
  if (text.startsWith("event:") || text.startsWith("data:")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line!.slice(5).trim());
  }
  return JSON.parse(text);
}

describe.skipIf(!hasDb)("MCP Streamable HTTP transport (integration)", () => {
  let roomId = "";
  let userId = "";
  let outsiderId = "";
  let token = "";

  beforeAll(async () => {
    const [user, outsider] = await Promise.all([
      prisma.user.create({
        data: { name: "Engineer", email: `mcp-eng-${suffix}@test.local` },
      }),
      prisma.user.create({
        data: { name: "Outsider", email: `mcp-out-${suffix}@test.local` },
      }),
    ]);
    userId = user.id;
    outsiderId = outsider.id;

    const room = await prisma.room.create({
      data: {
        name: "MCP Room",
        slug: `mcp-room-${suffix}`,
        createdById: user.id,
        memberships: { create: [{ userId: user.id, role: "ENGINEER" }] },
      },
    });
    roomId = room.id;

    ({ token } = await issueAgentCredential({
      roomId,
      userId: user.id,
      name: "test-agent",
    }));
  });

  afterAll(async () => {
    await prisma.room.delete({ where: { id: roomId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [userId, outsiderId] } } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    signedInUserId = null;
  });

  // --- Authentication -------------------------------------------------------

  describe("authentication", () => {
    it("refuses an unauthenticated request", async () => {
      const response = await POST(rpc(INITIALIZE));
      expect(response.status).toBe(401);

      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNAUTHENTICATED");
    });

    it("refuses a malformed Authorization header", async () => {
      const response = await POST(rpc(INITIALIZE, { authorization: "Token abc" }));
      expect(response.status).toBe(401);
    });

    it("refuses an unknown bearer token", async () => {
      const response = await POST(
        rpc(INITIALIZE, { authorization: "Bearer devroom_mcp_not-a-real-token" }),
      );
      expect(response.status).toBe(401);
    });

    it("accepts a valid agent credential", async () => {
      const response = await POST(rpc(INITIALIZE, { authorization: `Bearer ${token}` }));
      expect(response.status).toBe(200);

      const body = await readJson(response);
      expect(body.result).toMatchObject({
        protocolVersion: expect.any(String),
        serverInfo: { name: "vuln-dev-room-coordination" },
      });
    });

    it("accepts a signed-in session as an alternative principal", async () => {
      signedInUserId = userId;
      const response = await POST(rpc(INITIALIZE));
      expect(response.status).toBe(200);
    });
  });

  // --- Protocol -------------------------------------------------------------

  describe("protocol", () => {
    async function callTool(name: string, args: Record<string, unknown> = {}) {
      const response = await POST(
        rpc(
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name, arguments: args },
          },
          { authorization: `Bearer ${token}` },
        ),
      );
      return { response, body: await readJson(response) };
    }

    it("advertises exactly the twelve Phase 1 tools", async () => {
      const response = await POST(
        rpc(
          { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
          { authorization: `Bearer ${token}` },
        ),
      );
      expect(response.status).toBe(200);

      const body = await readJson(response);
      const tools = (body.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(
        [
          "claim_work_unit",
          "complete_work_unit",
          "create_agent_session",
          "get_context_delta",
          "get_worker_context",
          "health_check",
          "heartbeat_work_unit",
          "join_agent_session",
          "list_work_units",
          "publish_discovery",
          "publish_work_units",
          "release_work_unit",
        ].sort(),
      );
    });

    it("publishes an input schema for every tool", async () => {
      const response = await POST(
        rpc(
          { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
          { authorization: `Bearer ${token}` },
        ),
      );
      const body = await readJson(response);
      const tools = (body.result as {
        tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
      }).tools;

      for (const tool of tools) {
        expect(tool.inputSchema, `${tool.name} needs an input schema`).toBeDefined();
        expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      }
    });

    it("answers health_check without needing room membership", async () => {
      const { response, body } = await callTool("health_check");
      expect(response.status).toBe(200);

      const result = body.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      const report = JSON.parse(result.content[0]!.text);
      expect(report.checks.database.status).toBe("up");
    });

    it("runs a full create → join → publish → claim flow over the transport", async () => {
      const created = await callTool("create_agent_session", {
        title: "Transport flow",
        description: "Exercises the tools end-to-end over Streamable HTTP.",
      });
      const session = JSON.parse(
        (created.body.result as { content: Array<{ text: string }> }).content[0]!.text,
      );
      expect(session.sessionId).toBeTruthy();

      await callTool("join_agent_session", {
        session_id: session.sessionId,
        agent_label: "scanner-1",
        harness_type: "claude_code",
      });
      await callTool("publish_work_units", {
        session_id: session.sessionId,
        work_units: [{ key: "authz", title: "Review authorization" }],
      });
      const claimed = await callTool("claim_work_unit", {
        session_id: session.sessionId,
        work_unit_key: "authz",
        agent_label: "scanner-1",
      });

      const claim = JSON.parse(
        (claimed.body.result as { content: Array<{ text: string }> }).content[0]!.text,
      );
      expect(claim.claimed).toBe(true);
      expect(claim.heldBy).toBe("scanner-1");
    });

    it("reports a schema violation as a tool error, not a transport failure", async () => {
      // Confidence above 1 — the model should see this and be able to correct
      // it, so it must come back as a tool error rather than a protocol fault.
      const { response, body } = await callTool("publish_discovery", {
        session_id: "3f1e5b6a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
        agent_label: "x",
        type: "note",
        title: "t",
        content: "c",
        confidence: 5,
      });
      expect(response.status).toBe(200);
      const result = body.result as { isError?: boolean } | undefined;
      // Either an isError tool result or a JSON-RPC error is acceptable; what
      // must NOT happen is a 500.
      expect(result?.isError ?? Boolean(body.error)).toBe(true);
    });

    it("hides another room's session behind NOT_FOUND", async () => {
      const otherRoom = await prisma.room.create({
        data: {
          name: "Other",
          slug: `mcp-other-${suffix}`,
          createdById: outsiderId,
          memberships: { create: [{ userId: outsiderId, role: "OWNER" }] },
        },
      });
      const foreign = await prisma.agentSession.create({
        data: {
          roomId: otherRoom.id,
          createdById: outsiderId,
          title: "Foreign",
          description: "Belongs to another tenant.",
        },
      });

      const { body } = await callTool("get_worker_context", {
        session_id: foreign.id,
      });
      const result = body.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0]!.text);
      // NOT_FOUND, never FORBIDDEN — the latter would confirm it exists.
      expect(payload.error.code).toBe("NOT_FOUND");

      await prisma.room.delete({ where: { id: otherRoom.id } });
    });
  });

  // --- Transport shape ------------------------------------------------------

  describe("transport shape", () => {
    it("answers GET with 405 and an Allow header", async () => {
      // This deployment is stateless and offers no standalone SSE stream;
      // saying so explicitly beats letting a client hang on a request that
      // will never produce events.
      const response = await GET();
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    });

    it("returns JSON rather than an SSE stream", async () => {
      const response = await POST(rpc(INITIALIZE, { authorization: `Bearer ${token}` }));
      expect(response.headers.get("content-type")).toContain("application/json");
    });

    it("issues no session id, so any instance can serve any request", async () => {
      const response = await POST(rpc(INITIALIZE, { authorization: `Bearer ${token}` }));
      expect(response.headers.get("mcp-session-id")).toBeNull();
    });
  });

  // --- Feature flag ---------------------------------------------------------

  describe("feature flag", () => {
    it("refuses every request when the endpoint is disabled", async () => {
      vi.resetModules();
      vi.doMock("@/env", async (importOriginal) => {
        const actual = await importOriginal<typeof import("@/env")>();
        return { ...actual, isMcpEnabled: false };
      });

      const { POST: disabledPost } = await import("@/app/api/mcp/route");
      const response = await disabledPost(
        rpc(INITIALIZE, { authorization: `Bearer ${token}` }),
      );
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INTEGRATION_NOT_CONFIGURED");

      vi.doUnmock("@/env");
      vi.resetModules();
    });
  });
});
