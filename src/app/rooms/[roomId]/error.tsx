"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function RoomError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        We couldn&apos;t load this room. Please try again.
      </p>
      <div className="mt-6 flex gap-2">
        <Button onClick={reset}>Retry</Button>
        <Link href="/rooms">
          <Button variant="outline">Back to rooms</Button>
        </Link>
      </div>
    </main>
  );
}
