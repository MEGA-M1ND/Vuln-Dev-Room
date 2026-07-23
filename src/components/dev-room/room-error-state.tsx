import Link from "next/link";

import { Button } from "@/components/ui/button";

/** Reusable full-screen state for room-level errors (unauthorized/not-found). */
export function RoomErrorState({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      <Link href="/rooms" className="mt-6">
        <Button>Back to your rooms</Button>
      </Link>
    </main>
  );
}
