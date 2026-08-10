// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

/**
 * Authentication must be the FIRST gate on a room-scoped read endpoint.
 *
 * These routes take `roomId` as a query parameter, so it is tempting to validate
 * that parameter before doing anything else. Doing so answers an anonymous
 * caller's request with a 400 that describes the endpoint's parameter contract —
 * telling an unauthenticated stranger how the API is shaped, and reporting the
 * wrong status code for what actually went wrong.
 *
 * The expected order is: 401 if not signed in, and only then 400 for a bad
 * request. This test pins that order by calling each handler with no session and
 * no query string at all — the exact case where the two checks disagree.
 */

// Anonymous: `auth()` resolves to no session, so `requireUser()` throws 401.
vi.mock("@/auth", () => ({
  auth: vi.fn(async () => null),
}));

import { NextRequest } from "next/server";

import { GET as getPolicies } from "@/app/api/policies/route";
import { GET as getRuns } from "@/app/api/runs/route";
import { GET as getRepositories } from "@/app/api/github/repositories/route";
import { GET as getHandoffs, POST as postHandoff } from "@/app/api/handoffs/route";
import { POST as postAcknowledge } from "@/app/api/handoffs/[handoffId]/acknowledge/route";
import { POST as postApprove } from "@/app/api/handoffs/[handoffId]/approve/route";

const ROUTES = [
  {
    name: "GET /api/policies",
    handler: getPolicies,
    url: "http://localhost/api/policies",
  },
  {
    name: "GET /api/runs",
    handler: getRuns,
    url: "http://localhost/api/runs",
  },
  {
    name: "GET /api/github/repositories",
    handler: getRepositories,
    url: "http://localhost/api/github/repositories",
  },
  {
    name: "GET /api/handoffs",
    handler: getHandoffs,
    url: "http://localhost/api/handoffs",
  },
] as const;

describe("room-scoped read endpoints authenticate before validating input", () => {
  for (const route of ROUTES) {
    it(`${route.name} answers an anonymous caller with 401, not 400`, async () => {
      const response = await route.handler(new NextRequest(route.url));

      expect(response.status).toBe(401);

      const body = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("UNAUTHENTICATED");

      // The parameter contract must not leak to an unauthenticated caller.
      expect(JSON.stringify(body)).not.toContain("roomId");
    });
  }
});

describe("handoff mutation endpoints authenticate before touching the database", () => {
  it("POST /api/handoffs answers an anonymous caller with 401, not 400", async () => {
    // No body at all: a validate-first handler would fail parsing the JSON
    // before it ever got to checking who is asking.
    const response = await postHandoff(
      new NextRequest("http://localhost/api/handoffs", { method: "POST" }),
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("POST /api/handoffs/:id/acknowledge answers an anonymous caller with 401, not a database lookup", async () => {
    const response = await postAcknowledge(
      new NextRequest(
        "http://localhost/api/handoffs/does-not-exist/acknowledge",
        { method: "POST" },
      ),
      { params: Promise.resolve({ handoffId: "does-not-exist" }) },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("POST /api/handoffs/:id/approve answers an anonymous caller with 401, not a database lookup", async () => {
    const response = await postApprove(
      new NextRequest("http://localhost/api/handoffs/does-not-exist/approve", {
        method: "POST",
      }),
      { params: Promise.resolve({ handoffId: "does-not-exist" }) },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });
});
