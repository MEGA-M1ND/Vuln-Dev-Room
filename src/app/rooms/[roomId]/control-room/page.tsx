import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { getControlRoom } from "@/lib/control-room/service";
import { RoomErrorState } from "@/components/dev-room/room-error-state";
import { ControlRoom } from "@/components/control-room/control-room-view";

export const dynamic = "force-dynamic";

export default async function ControlRoomPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/");

  // Authorization: resolve the caller's real membership from Postgres.
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

  const [room, initial] = await Promise.all([
    prisma.room.findUniqueOrThrow({
      where: { id: roomId },
      select: { name: true },
    }),
    getControlRoom(roomId),
  ]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <Link
        href={`/rooms/${roomId}`}
        className="text-sm text-muted-foreground hover:underline"
      >
        ← {room.name}
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Control room</h1>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Every agent working in this repository, in one place: what is in flight,
        what is waiting on a person, what just landed, and where two pieces of
        work might collide.
      </p>

      <div className="mt-8">
        <ControlRoom roomId={roomId} role={membership.role} initial={initial} />
      </div>
    </main>
  );
}
