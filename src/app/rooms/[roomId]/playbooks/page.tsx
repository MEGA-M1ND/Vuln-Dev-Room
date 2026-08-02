import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { listPlaybooks } from "@/lib/playbooks/service";
import { RoomErrorState } from "@/components/dev-room/room-error-state";
import { PlaybookList } from "@/components/playbooks/playbook-list";

export const dynamic = "force-dynamic";

export default async function PlaybooksPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/");

  // Same membership rule as the room itself: non-members see "not found".
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

  const [room, playbooks] = await Promise.all([
    prisma.room.findUniqueOrThrow({
      where: { id: roomId },
      select: { name: true },
    }),
    listPlaybooks(roomId),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link
        href={`/rooms/${roomId}`}
        className="text-sm text-muted-foreground hover:underline"
      >
        ← {room.name}
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Playbooks</h1>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Recipes distilled from runs that worked. Start a new agent run from a
        playbook to reuse an approach your team already trusts.
      </p>

      <div className="mt-8">
        <PlaybookList
          roomId={roomId}
          initialPlaybooks={playbooks}
          role={membership.role}
        />
      </div>
    </main>
  );
}
