// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

import { prisma } from "@/lib/db/client";
import { createAgentRun } from "@/lib/agent/runs";
import { can } from "@/lib/permissions";
import { ApiError } from "@/lib/api/errors";

// requestReview's only external dependency is the internal agent-runtime HTTP
// call — mocked for the same reason as forkRun's tests (see forks.test.ts):
// no live runtime process in this test run, but the mock performs the same DB
// write the real runtime would, so the transaction/failure-handling logic is
// still exercised against real Postgres.
vi.mock("@/lib/agent/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/client")>();
  return { ...actual, startReviewAgentRun: vi.fn() };
});

import { startReviewAgentRun } from "@/lib/agent/client";
import { requestReview } from "@/lib/agent/reviews";

const mockStartReviewAgentRun = vi.mocked(startReviewAgentRun);

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `review-${Date.now()}`;

describe.skipIf(!hasDb)("Reviewer-agent (roadmap Phase 5, integration)", () => {
  let roomId = "";
  let ticketId = "";
  let ownerId = "";
  let engineerId = "";

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { name: "Review Owner", email: `owner-${suffix}@test.local` },
    });
    const engineer = await prisma.user.create({
      data: { name: "Review Engineer", email: `eng-${suffix}@test.local` },
    });
    ownerId = owner.id;
    engineerId = engineer.id;

    const room = await prisma.room.create({
      data: {
        name: "Review Room",
        slug: `review-room-${suffix}`,
        createdById: owner.id,
        memberships: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: engineer.id, role: "ENGINEER" },
          ],
        },
      },
    });
    roomId = room.id;
    const ticket = await prisma.ticket.create({
      data: { roomId, title: "Source ticket", createdById: owner.id, position: 1000 },
    });
    ticketId = ticket.id;
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, engineerId] } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.agentRun.deleteMany({ where: { ticketId } });
    mockStartReviewAgentRun.mockReset();
  });

  async function freshRun() {
    return createAgentRun({
      roomId,
      ticketId,
      requestedById: ownerId,
      targetRepositoryKey: "agentguard-demo",
    });
  }

  it("starting a run (run:create) is the only permission reviewer-agent needs — no new permission was added", () => {
    expect(can("OWNER", "run:create")).toBe(true);
    expect(can("ENGINEER", "run:create")).toBe(true);
    expect(can("VIEWER", "run:create")).toBe(false);
  });

  it("only a SUCCEEDED run can be reviewed", async () => {
    const run = await freshRun();
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "RUNNING" } });

    await expect(requestReview(run.id, engineerId)).rejects.toMatchObject({
      code: "RUN_NOT_REVIEWABLE",
    });
    expect(mockStartReviewAgentRun).not.toHaveBeenCalled();
  });

  it("a reviewer-agent run cannot itself be reviewed (no review chains)", async () => {
    const source = await freshRun();
    await prisma.agentRun.update({
      where: { id: source.id },
      data: { status: "SUCCEEDED", activeTicketId: null },
    });
    const reviewer = await prisma.agentRun.create({
      data: {
        roomId,
        ticketId,
        requestedById: ownerId,
        agentId: "reviewer-agent",
        status: "SUCCEEDED",
        graphThreadId: `thread_${suffix}_reviewer`,
        targetRepositoryKey: "agentguard-demo",
        reviewedRunId: source.id,
      },
    });

    await expect(requestReview(reviewer.id, engineerId)).rejects.toMatchObject({
      code: "RUN_NOT_REVIEWABLE",
    });
  });

  it("reviewing a run that does not exist is a 404", async () => {
    await expect(requestReview("does-not-exist", engineerId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("starts a reviewer-agent run on the SAME ticket, not a clone", async () => {
    const source = await freshRun();
    await prisma.agentRun.update({
      where: { id: source.id },
      data: { status: "SUCCEEDED", activeTicketId: null },
    });

    mockStartReviewAgentRun.mockImplementation(async (runId) => {
      await prisma.agentRun.update({ where: { id: runId }, data: { status: "RUNNING" } });
    });

    const review = await requestReview(source.id, engineerId);

    expect(mockStartReviewAgentRun).toHaveBeenCalledWith(review.id, source.id);
    expect(review.agentId).toBe("reviewer-agent");
    expect(review.reviewedRunId).toBe(source.id);
    expect(review.ticketId).toBe(source.ticketId); // unlike a fork: no new ticket
    expect(review.parentRunId).toBeNull();

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: review.id } });
    expect(row.activeTicketId).toBe(ticketId);
    expect(row.requestedById).toBe(engineerId);

    const events = await prisma.runEvent.findMany({ where: { runId: review.id } });
    expect(events.map((e) => e.type)).toContain("RUN_CREATED");
  });

  it("an unreachable runtime fails the review run and releases the ticket's active slot", async () => {
    const source = await freshRun();
    await prisma.agentRun.update({
      where: { id: source.id },
      data: { status: "SUCCEEDED", activeTicketId: null },
    });
    mockStartReviewAgentRun.mockRejectedValue(
      new ApiError("INTERNAL_ERROR", "Could not reach the agent runtime service."),
    );

    await expect(requestReview(source.id, ownerId)).rejects.toThrow();

    const reviewRow = await prisma.agentRun.findFirstOrThrow({
      where: { reviewedRunId: source.id },
    });
    expect(reviewRow.status).toBe("FAILED");
    expect(reviewRow.errorCode).toBe("RUNTIME_UNAVAILABLE");
    expect(reviewRow.activeTicketId).toBeNull();
    // The lineage forkRun controls directly still recorded correctly.
    expect(reviewRow.ticketId).toBe(ticketId);
  });

  it("cannot review while the ticket already has another active run", async () => {
    const source = await freshRun();
    await prisma.agentRun.update({
      where: { id: source.id },
      data: { status: "SUCCEEDED", activeTicketId: null },
    });
    // Simulate a second, concurrently active run on the same ticket.
    const blocker = await prisma.agentRun.create({
      data: {
        roomId,
        ticketId,
        requestedById: ownerId,
        agentId: "backend-agent",
        status: "RUNNING",
        graphThreadId: `thread_${suffix}_blocker`,
        targetRepositoryKey: "agentguard-demo",
        activeTicketId: ticketId,
      },
    });

    await expect(requestReview(source.id, engineerId)).rejects.toMatchObject({
      code: "RUN_ALREADY_ACTIVE",
    });
    expect(mockStartReviewAgentRun).not.toHaveBeenCalled();

    await prisma.agentRun.delete({ where: { id: blocker.id } });
  });
});
