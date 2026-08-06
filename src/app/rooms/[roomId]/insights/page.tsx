import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { getRoomInsights } from "@/lib/insights/service";
import { RoomErrorState } from "@/components/dev-room/room-error-state";
import { InsightsView } from "@/components/insights/insights-view";
import { RiskSignals } from "@/components/dev-room/risk-signals";

export const dynamic = "force-dynamic";

export default async function InsightsPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/");

  const membership = await prisma.roomMembership.findUnique({
    where: { roomId_userId: { roomId, userId: user.id } },
    select: { role: true },
  });
  if (!membership) {
    return (
      <RoomErrorState
        title="Room not found"
        message="This room doesn't exist, or you are not a member of it."
      />
    );
  }

  const [room, insights] = await Promise.all([
    prisma.room.findUniqueOrThrow({
      where: { id: roomId },
      select: { name: true },
    }),
    getRoomInsights(roomId, "30d"),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link
        href={`/rooms/${roomId}`}
        className="text-sm text-muted-foreground hover:underline"
      >
        ← {room.name}
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Insights</h1>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        A small set of numbers to tell you whether agent work is landing, and
        where your team is having to step in.
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-medium">Needs attention</h2>
        <p className="mb-3 mt-1 max-w-prose text-sm text-muted-foreground">
          Transparent heuristics over active work — overlapping files, critical
          paths, scope growth, failing checks and stalled runs. These are
          prompts for a human to look, not verdicts about whether code is
          correct.
        </p>
        <RiskSignals roomId={roomId} role={membership.role} />
      </section>

      <div className="mt-8">
        <InsightsView roomId={roomId} initial={insights} />
      </div>
    </main>
  );
}
