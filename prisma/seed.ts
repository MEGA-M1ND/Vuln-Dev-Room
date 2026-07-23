import { PrismaClient, MembershipRole, TicketStatus, TicketPriority } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Deterministic, idempotent seed. Safe to run multiple times — every entity is
 * upserted on a stable natural key, so re-running does not create duplicates.
 */
async function main() {
  // --- Users -----------------------------------------------------------------
  const prasanna = await prisma.user.upsert({
    where: { email: "prasanna@devroom.local" },
    update: {},
    create: {
      name: "Prasanna",
      email: "prasanna@devroom.local",
      image: null,
    },
  });

  const priya = await prisma.user.upsert({
    where: { email: "priya@devroom.local" },
    update: {},
    create: { name: "Priya", email: "priya@devroom.local", image: null },
  });

  const arun = await prisma.user.upsert({
    where: { email: "arun@devroom.local" },
    update: {},
    create: { name: "Arun", email: "arun@devroom.local", image: null },
  });

  // --- Room ------------------------------------------------------------------
  const room = await prisma.room.upsert({
    where: { slug: "agentguard-development" },
    update: {},
    create: {
      name: "AgentGuard Development",
      slug: "agentguard-development",
      repositoryName: "agentguard-api",
      repositoryUrl: "https://github.com/example/agentguard-api",
      createdById: prasanna.id,
    },
  });

  // --- Memberships -----------------------------------------------------------
  const memberships: Array<[string, MembershipRole]> = [
    [prasanna.id, MembershipRole.OWNER],
    [priya.id, MembershipRole.ENGINEER],
    [arun.id, MembershipRole.ENGINEER],
  ];

  for (const [userId, role] of memberships) {
    await prisma.roomMembership.upsert({
      where: { roomId_userId: { roomId: room.id, userId } },
      update: { role },
      create: { roomId: room.id, userId, role },
    });
  }

  // --- Tickets ---------------------------------------------------------------
  // Keyed by a deterministic id so re-seeding is idempotent.
  const tickets = [
    {
      id: "seed-ticket-rate-limit",
      title: "Add rate-limit tests",
      description:
        "Cover the token-bucket limiter with unit + integration tests, including burst and refill behavior.",
      status: TicketStatus.BACKLOG,
      priority: TicketPriority.MEDIUM,
      assigneeId: null,
      position: 1000,
      createdById: prasanna.id,
    },
    {
      id: "seed-ticket-jwt",
      title: "Refactor JWT validation",
      description:
        "Extract JWT verification into a reusable module and validate audience + issuer claims.",
      status: TicketStatus.IN_PROGRESS,
      priority: TicketPriority.HIGH,
      assigneeId: priya.id,
      position: 1000,
      createdById: priya.id,
    },
    {
      id: "seed-ticket-policy-audit",
      title: "Policy audit endpoint",
      description:
        "Expose a read-only endpoint that returns the effective policy decision trace for a request.",
      status: TicketStatus.REVIEW,
      priority: TicketPriority.URGENT,
      assigneeId: arun.id,
      position: 1000,
      createdById: arun.id,
    },
    {
      id: "seed-ticket-agent-identity",
      title: "Agent identity schema",
      description:
        "Define the durable schema for agent identities and their capability grants.",
      status: TicketStatus.DONE,
      priority: TicketPriority.LOW,
      assigneeId: prasanna.id,
      position: 1000,
      createdById: prasanna.id,
    },
  ];

  for (const t of tickets) {
    await prisma.ticket.upsert({
      where: { id: t.id },
      update: {
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        assigneeId: t.assigneeId,
        position: t.position,
        roomId: room.id,
      },
      create: { ...t, roomId: room.id },
    });
  }

  console.log("Seed complete:");
  console.log(`  Room:     ${room.name} (${room.slug})`);
  console.log(`  Users:    Prasanna (OWNER), Priya (ENGINEER), Arun (ENGINEER)`);
  console.log(`  Tickets:  ${tickets.length}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
