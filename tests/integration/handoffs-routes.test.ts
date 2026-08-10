// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

/**
 * Regression coverage for a route-level bug: both mutation routes originally
 * gated on `requireRoomPermission(roomId, "run:handoff")`, an action scoped to
 * OWNER/ENGINEER (who may *author* a handoff). A REVIEWER — the role Feature 3
 * exists to route approvals to, and the role this test signs in as — does not
 * hold that action, so every REVIEWER got a 403 before the request ever
 * reached `acknowledgeHandoffCard`/`approveHandoffCard`, whose own eligibility
 * checks correctly treat REVIEWER as allowed. `tests/integration/handoffs.test.ts`
 * calls those service functions directly and could not have caught this: the
 * bug lived entirely in the route's permission gate. This file exercises the
 * actual route handlers instead, with a mocked session, so the gate is part
 * of what's under test.
 */

let currentUserId: string | null = null;

vi.mock("@/auth", () => ({
  auth: vi.fn(async () =>
    currentUserId
      ? { user: { id: currentUserId, name: "Test User", email: "t@test.local" } }
      : null,
  ),
}));

import { NextRequest } from "next/server";

import { prisma } from "@/lib/db/client";
import { POST as postAcknowledge } from "@/app/api/handoffs/[handoffId]/acknowledge/route";
import { POST as postApprove } from "@/app/api/handoffs/[handoffId]/approve/route";
import type { Prisma } from "@prisma/client";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `handoff-routes-${Date.now()}`;

function highRiskResult(
  ownerUserId?: string,
): Prisma.BlastRadiusQueryResultCreateInput["resultJson"] {
  return {
    seeds: ["src/lib/auth.ts"],
    affectedFiles: Array.from({ length: 25 }, (_, i) => ({
      path: `src/lib/file-${i}.ts`,
      depth: 1,
      importedBy: i === 0 ? 20 : 0,
      isCriticalPath: i === 0,
    })),
    contractsTouched: ["src/lib/"],
    apiEndpointsTouched: [],
    owners: ownerUserId
      ? [
          {
            path: "src/lib/auth.ts",
            owners: [{ userId: ownerUserId, name: "Owner", email: "o@x.com", commits: 3, score: 1 }],
          },
        ]
      : [],
    summaryAudience: "ENGINEER",
  };
}

describe.skipIf(!hasDb)("handoff mutation routes (integration)", () => {
  let roomId = "";
  let taskId = "";
  let ownerId = "";
  let engineerId = "";
  let reviewerId = "";
  let viewerId = "";

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { name: "Owner", email: `owner-${suffix}@test.local` },
    });
    ownerId = owner.id;
    const engineer = await prisma.user.create({
      data: { name: "Engineer", email: `engineer-${suffix}@test.local` },
    });
    engineerId = engineer.id;
    const reviewer = await prisma.user.create({
      data: { name: "Reviewer", email: `reviewer-${suffix}@test.local` },
    });
    reviewerId = reviewer.id;
    const viewer = await prisma.user.create({
      data: { name: "Viewer", email: `viewer-${suffix}@test.local` },
    });
    viewerId = viewer.id;

    const room = await prisma.room.create({
      data: {
        name: "Handoff Routes Room",
        slug: `handoff-routes-room-${suffix}`,
        createdById: owner.id,
        memberships: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: engineer.id, role: "ENGINEER" },
            { userId: reviewer.id, role: "REVIEWER" },
            { userId: viewer.id, role: "VIEWER" },
          ],
        },
      },
    });
    roomId = room.id;

    const task = await prisma.agentTask.create({
      data: {
        roomId,
        title: "Fix session expiry",
        createdById: owner.id,
        assigneeId: reviewer.id,
        position: 1000,
      },
    });
    taskId = task.id;
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    await prisma.user.deleteMany({
      where: { id: { in: [ownerId, engineerId, reviewerId, viewerId] } },
    });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    currentUserId = null;
    await prisma.handoffCard.deleteMany({ where: { roomId } });
    await prisma.blastRadiusQueryResult.deleteMany({ where: { roomId } });
  });

  it("lets a REVIEWER, the named recipient, acknowledge through the actual route", async () => {
    const card = await prisma.handoffCard.create({
      data: {
        roomId,
        taskId,
        fromUserId: engineerId,
        fromActorLabel: "Engineer",
        toUserId: reviewerId,
        toActorLabel: "Reviewer",
        diffSummary: "Done.",
        openQuestions: [],
        status: "PENDING",
      },
    });

    currentUserId = reviewerId;
    const response = await postAcknowledge(
      new NextRequest(`http://localhost/api/handoffs/${card.id}/acknowledge`, {
        method: "POST",
      }),
      { params: Promise.resolve({ handoffId: card.id }) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { card: { status: string } };
    expect(body.card.status).toBe("ACKNOWLEDGED");
  });

  it("lets a REVIEWER approve a NEEDS_APPROVAL card through the actual route", async () => {
    const result = await prisma.blastRadiusQueryResult.create({
      data: {
        roomId,
        requestedById: ownerId,
        queryJson: { roomId, targetPath: "src/lib/auth.ts" },
        resultJson: highRiskResult() as Prisma.InputJsonValue,
        summary: "Synthetic high-risk result.",
        fileCount: 25,
      },
    });
    const card = await prisma.handoffCard.create({
      data: {
        roomId,
        taskId,
        fromUserId: engineerId,
        fromActorLabel: "Engineer",
        toUserId: reviewerId,
        toActorLabel: "Reviewer",
        diffSummary: "High risk change.",
        openQuestions: [],
        status: "NEEDS_APPROVAL",
        riskScore: 80,
        blastRadiusResultId: result.id,
      },
    });

    currentUserId = reviewerId;
    const response = await postApprove(
      new NextRequest(`http://localhost/api/handoffs/${card.id}/approve`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ handoffId: card.id }) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { card: { status: string } };
    expect(body.card.status).toBe("APPROVED");
  });

  it("still refuses acknowledgement from a VIEWER who is not the recipient", async () => {
    const card = await prisma.handoffCard.create({
      data: {
        roomId,
        taskId,
        fromUserId: engineerId,
        fromActorLabel: "Engineer",
        toUserId: reviewerId,
        toActorLabel: "Reviewer",
        diffSummary: "Done.",
        openQuestions: [],
        status: "PENDING",
      },
    });

    currentUserId = viewerId;
    const response = await postAcknowledge(
      new NextRequest(`http://localhost/api/handoffs/${card.id}/acknowledge`, {
        method: "POST",
      }),
      { params: Promise.resolve({ handoffId: card.id }) },
    );

    expect(response.status).toBe(403);
  });
});
