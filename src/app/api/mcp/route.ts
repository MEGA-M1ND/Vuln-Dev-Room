import { NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { isMcpEnabled } from "@/env";
import { ApiError, handleRouteError } from "@/lib/api/errors";
import { authenticateMcpPrincipal } from "@/lib/mcp/auth";
import { buildMcpServer } from "@/lib/mcp/server";

/**
 * POST /api/mcp — remote MCP endpoint (Streamable HTTP).
 *
 * TRANSPORT: `WebStandardStreamableHTTPServerTransport`, the SDK's
 * Web-standard implementation. It takes a `Request` and returns a `Response`,
 * so it drops into an App Router handler with no Node `IncomingMessage` shim.
 *
 * STATELESS, by choice. `sessionIdGenerator: undefined` +
 * `enableJsonResponse: true` means each POST is self-contained and answered
 * with JSON rather than an SSE stream. Two reasons:
 *
 *  - This app deploys serverlessly (see vercel.json). A stateful transport
 *    holding in-memory session state breaks the moment a second instance
 *    exists, in a way that is intermittent and miserable to debug.
 *  - There is no durable state to keep in the transport anyway. PostgreSQL is
 *    the source of truth, and clients learn what changed through
 *    `get_context_delta`, not through a held-open stream.
 *
 * The MCP spec permits a JSON response in place of an SSE stream, so native
 * clients handle this normally.
 *
 * AUTH: resolved ONCE here, before any tool runs, and captured in the server's
 * closure — a tool cannot act as a different principal because no tool takes
 * an identity argument. See `src/lib/mcp/auth.ts`.
 */
export const runtime = "nodejs";
// Auth depends on headers/cookies, so this can never be statically rendered.
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    if (!isMcpEnabled) {
      throw new ApiError(
        "INTEGRATION_NOT_CONFIGURED",
        "The MCP coordination endpoint is disabled. Set DEVROOM_MCP_ENABLED=true to enable it.",
      );
    }

    const principal = await authenticateMcpPrincipal(req);
    const server = buildMcpServer(principal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      // One server + transport per request; nothing is cached across requests,
      // so nothing may leak between principals.
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * GET is the Streamable HTTP server-push stream. This deployment does not
 * offer one: realtime notification is Liveblocks' job (clients already hold
 * that connection for the board), and holding a second long-lived stream open
 * per agent would not survive the serverless model. 405 is the spec's answer
 * for a server that does not support the standalone stream.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json(
    {
      error: {
        code: "BAD_REQUEST",
        message:
          "This MCP endpoint is stateless and does not offer a standalone SSE stream. POST JSON-RPC requests instead; poll get_context_delta for changes.",
        details: {},
      },
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}
