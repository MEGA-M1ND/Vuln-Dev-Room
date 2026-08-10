// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// The runtime is a separate service; stubbing the one call across the boundary
// keeps this test about our orchestration — repository resolution, owner
// linking, persistence, ordering — rather than about network behaviour.
vi.mock("@/lib/agent/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/client")>();
  return { ...actual, requestBlastRadius: vi.fn() };
});

import { requestBlastRadius } from "@/lib/agent/client";
import { ApiError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";
import {
  listBlastRadiusQueries,
  runBlastRadiusQuery,
} from "@/lib/blast-radius/service";

const mockRequest = vi.mocked(requestBlastRadius);

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `br-${Date.now()}`;

function runtimePayload(overrides: Record<string, unknown> = {}) {
  return {
    seeds: ["src/lib/session.ts"],
    affectedFiles: [
      { path: "src/lib/session.ts", depth: 0, importedBy: 1, isCriticalPath: true },
      { path: "src/lib/auth.ts", depth: 1, importedBy: 2, isCriticalPath: true },
    ],
    contractsTouched: ["src/lib/"],
    apiEndpointsTouched: ["/api/login"],
    owners: [
      {
        path: "src/lib/auth.ts",
        owners: [
          { name: "Ada Lovelace", email: `ada-${suffix}@test.local`, commits: 4, score: 2.1 },
          { name: "External Person", email: "nobody@example.com", commits: 1, score: 0.4 },
        ],
      },
    ],
    summary: "Changing session reaches 2 files.",
    fileCount: 2,
    truncated: false,
    ...overrides,
  };
}

describe.skipIf(!hasDb)("blast radius (integration)", () => {
  let roomId = "";
  let userId = "";
  let otherRoomId = "";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: "Ada Lovelace", email: `ada-${suffix}@test.local` },
    });
    userId = user.id;

    const room = await prisma.room.create({
      data: {
        name: "Astra Engineering",
        slug: `astra-${suffix}`,
        createdById: user.id,
        memberships: { create: [{ userId: user.id, role: "ENGINEER" }] },
      },
    });
    roomId = room.id;

    await prisma.repositoryConnection.create({
      data: {
        roomId,
        owner: "astra-engineering",
        repo: "payments-api",
        defaultBranch: "main",
        isActive: true,
        criticalPaths: ["src/lib/"],
      },
    });

    // A second room with no repository, to prove the failure path.
    const other = await prisma.room.create({
      data: {
        name: "No Repo Room",
        slug: `norepo-${suffix}`,
        createdById: user.id,
        memberships: { create: [{ userId: user.id, role: "ENGINEER" }] },
      },
    });
    otherRoomId = other.id;
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    if (otherRoomId) await prisma.room.delete({ where: { id: otherRoomId } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    mockRequest.mockReset();
    await prisma.blastRadiusQueryResult.deleteMany({ where: { roomId } });
  });

  it("stores a result and returns it", async () => {
    mockRequest.mockResolvedValue(runtimePayload());

    const result = await runBlastRadiusQuery({
      query: { roomId, targetPath: "src/lib/session.ts" },
      requestedBy: { id: userId, name: "Ada Lovelace" },
      audience: "ENGINEER",
    });

    expect(result.fileCount).toBe(2);
    expect(result.contractsTouched).toEqual(["src/lib/"]);
    expect(result.apiEndpointsTouched).toEqual(["/api/login"]);

    const stored = await prisma.blastRadiusQueryResult.findUnique({
      where: { id: result.id },
    });
    expect(stored).not.toBeNull();
    expect(stored?.fileCount).toBe(2);
  });

  it("forwards the room's configured critical paths to the analyser", async () => {
    mockRequest.mockResolvedValue(runtimePayload());

    await runBlastRadiusQuery({
      query: { roomId, targetPath: "src/lib/session.ts" },
      requestedBy: { id: userId, name: "Ada Lovelace" },
      audience: "ENGINEER",
    });

    // The room's own definition of "critical" must drive the analysis, so the
    // panel and the risk signals cannot disagree about the same file.
    const sent = mockRequest.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.criticalPaths).toEqual(["src/lib/"]);
    expect(sent.owner).toBe("astra-engineering");
    expect(sent.repo).toBe("payments-api");
    expect(sent.revision).toBe("main");
  });

  it("links a git author to a user, and leaves unknown authors unlinked", async () => {
    mockRequest.mockResolvedValue(runtimePayload());

    const result = await runBlastRadiusQuery({
      query: { roomId, targetPath: "src/lib/session.ts" },
      requestedBy: { id: userId, name: "Ada Lovelace" },
      audience: "ENGINEER",
    });

    const owners = result.owners[0]?.owners ?? [];
    expect(owners.find((o) => o.email === `ada-${suffix}@test.local`)?.userId).toBe(userId);
    // An author with no account stays null rather than being invented.
    expect(owners.find((o) => o.email === "nobody@example.com")?.userId).toBeNull();
  });

  it("passes the requester's role through as the summary audience", async () => {
    mockRequest.mockResolvedValue(runtimePayload());

    const result = await runBlastRadiusQuery({
      query: { roomId, targetPath: "src/lib/session.ts" },
      requestedBy: { id: userId, name: "Ada Lovelace" },
      audience: "VIEWER",
    });

    expect(result.summaryAudience).toBe("VIEWER");
    const sent = mockRequest.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.audience).toBe("VIEWER");
  });

  it("refuses to analyse a room with no connected repository", async () => {
    await expect(
      runBlastRadiusQuery({
        query: { roomId: otherRoomId, targetPath: "src/lib/session.ts" },
        requestedBy: { id: userId, name: "Ada Lovelace" },
        audience: "ENGINEER",
      }),
    ).rejects.toBeInstanceOf(ApiError);

    // Nothing is stored for a query that could not run.
    const count = await prisma.blastRadiusQueryResult.count({
      where: { roomId: otherRoomId },
    });
    expect(count).toBe(0);
  });

  it("rejects a malformed runtime response instead of storing it", async () => {
    // A shape change in the separate service must surface as an error here,
    // not as a half-rendered panel.
    mockRequest.mockResolvedValue({ summary: "nope" });

    await expect(
      runBlastRadiusQuery({
        query: { roomId, targetPath: "src/lib/session.ts" },
        requestedBy: { id: userId, name: "Ada Lovelace" },
        audience: "ENGINEER",
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(await prisma.blastRadiusQueryResult.count({ where: { roomId } })).toBe(0);
  });

  it("lists results newest first", async () => {
    mockRequest.mockResolvedValue(runtimePayload());

    const first = await runBlastRadiusQuery({
      query: { roomId, targetPath: "src/lib/session.ts" },
      requestedBy: { id: userId, name: "Ada Lovelace" },
      audience: "ENGINEER",
    });
    const second = await runBlastRadiusQuery({
      query: { roomId, targetPath: "src/lib/auth.ts" },
      requestedBy: { id: userId, name: "Ada Lovelace" },
      audience: "ENGINEER",
    });

    const listed = await listBlastRadiusQueries(roomId);
    expect(listed.map((r) => r.id).slice(0, 2)).toEqual([second.id, first.id]);
    expect(listed[0]?.requestedBy.id).toBe(userId);
  });
});
