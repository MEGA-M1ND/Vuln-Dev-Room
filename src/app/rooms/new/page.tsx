import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { NewRoomForm } from "@/components/rooms/new-room-form";

export default async function NewRoomPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <Link
        href="/rooms"
        className="text-sm text-muted-foreground hover:underline"
      >
        ← Back to rooms
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Create a Dev Room</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Name your room and optionally link a repository. Repository details are
        metadata only in Stage 1 — nothing is cloned or fetched.
      </p>
      <div className="mt-8">
        <NewRoomForm />
      </div>
    </main>
  );
}
