/**
 * Set up the artifact-bound-approval demo, end to end.
 *
 *   npx tsx scripts/demo-approval-binding.ts [room-slug]
 *
 * Creates a run, drives it to its approval gate, and prints the URL to open.
 * Then tells you the one SQL statement that makes the approval go stale, so the
 * whole control is visible in about ninety seconds:
 *
 *   1. open the run     → "Bound to" panel: artifact digests, base commit,
 *                          policy digest, expiry countdown
 *   2. run the UPDATE   → reload
 *   3. the page          → red "Superseded" banner naming the exact artifact,
 *                          and the Approve button is gone
 *
 * Operational/demo tool. It writes to whatever database DATABASE_URL points at,
 * so point it at a development one.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const slug = process.argv[2] ?? "astra-engineering";

  const room = await prisma.room.findUnique({ where: { slug } });
  if (!room) {
    console.error(`No room with slug "${slug}". Run \`npm run db:seed\` first.`);
    process.exitCode = 1;
    return;
  }

  const engineer = await prisma.roomMembership.findFirst({
    where: { roomId: room.id, role: "ENGINEER" },
    include: { user: true },
  });
  if (!engineer) {
    console.error(`Room "${slug}" has no ENGINEER member to attribute the run to.`);
    process.exitCode = 1;
    return;
  }

  // The default profile. Deliberately NOT the `verified` profile: this demo is
  // about approval binding, and `verified` would additionally block delivery
  // until a platform-executed receipt exists, which the simulated executor
  // cannot produce. See docs/validation-provenance.md.
  const profile = await prisma.policyProfile.findFirst({
    where: { key: "standard" },
  });

  const task = await prisma.agentTask.create({
    data: {
      roomId: room.id,
      title: "Demo: bound approval",
      objective:
        "Drive a run to its approval gate so the binding panel and the superseded state can be demonstrated.",
      createdById: engineer.user.id,
      position: Date.now() % 1_000_000,
      riskLevel: "MEDIUM",
    },
  });

  const run = await prisma.agentRun.create({
    data: {
      roomId: room.id,
      taskId: task.id,
      requestedById: engineer.user.id,
      ownerUserId: engineer.user.id,
      graphThreadId: `demo-binding-${Date.now()}`,
      targetRepositoryKey: "astra-engineering/payments-api",
      baseRevision: "a1b2c3d4e5f6",
      status: "QUEUED",
      activeTaskId: task.id,
      mode: "PROPOSE_CODE_CHANGE",
      baseBranch: "main",
      policyProfileId: profile?.id ?? null,
      riskLevel: "MEDIUM",
      sandboxId: `sandbox-demo-${Date.now().toString(36)}`,
    },
  });

  console.log(`\nRun created: ${run.id}`);
  console.log(`\n1. Open  http://localhost:3000/runs/${run.id}`);
  console.log(`   Sign in as a room OWNER or REVIEWER — not ${engineer.user.email},`);
  console.log(`   who requested it, because self-approval is refused.`);
  console.log(`\n2. Press "Simulate run". The run drives itself to the approval gate.`);
  console.log(`   The "Bound to" panel shows the artifact digests, base commit,`);
  console.log(`   policy digest and expiry the decision is bound to.`);
  console.log(`\n3. Make the approval stale — edit the reviewed diff:\n`);
  console.log(
    `   psql "$DATABASE_URL" -c "UPDATE \\"RunArtifact\\" SET \\"contentText\\" = \\"contentText\\" || E'\\\\n+ malicious_line()' WHERE \\"runId\\"='${run.id}' AND type='DIFF';"`,
  );
  console.log(`\n4. Reload the page. The Approve button is gone, replaced by a red`);
  console.log(`   "Superseded" banner naming ARTIFACT_CONTENT_CHANGED and the`);
  console.log(`   exact artifact that moved. Nothing executed.\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
