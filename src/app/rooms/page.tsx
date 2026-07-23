import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { listRoomsForUser } from "@/lib/rooms/service";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Avatar } from "@/components/ui/avatar";

export const dynamic = "force-dynamic";

export default async function RoomsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  const rooms = await listRoomsForUser(user.id);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <Link
            href="/"
            className="text-sm text-muted-foreground hover:underline"
          >
            ← Dev Room
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">Your rooms</h1>
        </div>
        <div className="flex items-center gap-3">
          <Avatar name={user.name ?? "You"} id={user.id} image={user.image} />
          <SignOutButton />
        </div>
      </header>

      <div className="mt-8 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {rooms.length} {rooms.length === 1 ? "room" : "rooms"}
        </p>
        <Link href="/rooms/new">
          <Button>+ New room</Button>
        </Link>
      </div>

      {rooms.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-border p-12 text-center">
          <h2 className="text-lg font-medium">No rooms yet</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            Create your first Dev Room to start collaborating on a shared task
            board with your team.
          </p>
          <Link href="/rooms/new" className="mt-6 inline-block">
            <Button>Create a room</Button>
          </Link>
        </div>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {rooms.map((room) => (
            <li key={room.id}>
              <Link
                href={`/rooms/${room.id}`}
                className="block rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-medium">{room.name}</h3>
                  <Badge className="capitalize">
                    {room.role.toLowerCase()}
                  </Badge>
                </div>
                {room.repositoryName ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    <span aria-hidden="true">⎇ </span>
                    {room.repositoryName}
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">
                    No repository linked
                  </p>
                )}
                <div className="mt-4 flex gap-4 text-xs text-muted-foreground">
                  <span>{room.memberCount} members</span>
                  <span>{room.ticketCount} tickets</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
