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
