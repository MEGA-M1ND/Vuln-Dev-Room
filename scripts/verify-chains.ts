/**
 * Verify the tamper-evident audit chain for every run in an organization.
 *
 * Operational tool, not a test: point it at a real database to confirm that
 * nothing has rewritten history. Uses the pure hash-chain module directly so it
 * runs outside Next.js.
 *
 *   npx tsx scripts/verify-chains.ts [org-slug]
 */
import { PrismaClient } from "@prisma/client";

import { toVerifiable, verifyChain } from "../src/lib/audit/hash-chain";

const prisma = new PrismaClient();

async function main() {
  const slug = process.argv[2] ?? "astra-engineering";

  const runs = await prisma.agentRun.findMany({
    where: { room: { slug } },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true, task: { select: { title: true } } },
  });

  if (runs.length === 0) {
    console.log(`No runs found for organization "${slug}".`);
    return;
  }

  let failures = 0;

  for (const run of runs) {
    const events = await prisma.runEvent.findMany({
      where: { runId: run.id },
      orderBy: { sequence: "asc" },
    });
    const result = verifyChain(events.map(toVerifiable));
    if (!result.valid) failures += 1;

    console.log(
      `${result.valid ? "OK  " : "FAIL"} ${String(run.status).padEnd(18)} ` +
        `events=${String(result.eventCount).padStart(3)} ` +
        `${run.task.title}`,
    );
    if (!result.valid) console.log(`     ${result.summary}`);
  }

  console.log("");
  console.log(
    failures === 0
      ? `Audit trail verified across ${runs.length} run(s).`
      : `INTEGRITY CHECK FAILED for ${failures} of ${runs.length} run(s).`,
  );

  // Non-zero exit so this can gate a scheduled integrity job.
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
