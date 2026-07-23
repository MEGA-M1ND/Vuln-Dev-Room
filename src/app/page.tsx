import Link from "next/link";

import { getCurrentUser } from "@/lib/auth/session";
import { isDevAuthEnabled } from "@/env";
import { prisma } from "@/lib/db/client";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { SignInPanel } from "@/components/auth/sign-in-panel";
import { SignOutButton } from "@/components/auth/sign-out-button";

export default async function HomePage() {
  const user = await getCurrentUser();

  // For the dev switcher only: list existing users to sign in as.
  const seedUsers = isDevAuthEnabled
    ? await prisma.user.findMany({
        orderBy: { createdAt: "asc" },
        take: 8,
        select: { id: true, name: true, email: true, image: true },
      })
    : [];

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-10">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold">
            D
          </div>
          <span className="text-lg font-semibold">Dev Room</span>
        </div>
        {user ? (
          <div className="flex items-center gap-3">
            <Avatar name={user.name ?? "You"} id={user.id} image={user.image} />
            <span className="hidden text-sm sm:inline">{user.name}</span>
            <SignOutButton />
          </div>
        ) : null}
      </header>

      <div className="grid flex-1 items-center gap-12 py-12 lg:grid-cols-2">
        <section>
          <span className="inline-flex items-center rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground">
            Stage 1 · Multiplayer product shell
          </span>
          <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">
            A shared control room for engineering teams.
          </h1>
          <p className="mt-4 max-w-prose text-muted-foreground">
            Dev Room is a browser-based control room where engineers share a
            Kanban board, see who is online, track which ticket each teammate is
            viewing, and discuss work through realtime comments. Durable state
            lives in PostgreSQL; presence and comments are powered by Liveblocks.
          </p>
          <ul className="mt-6 grid gap-2 text-sm text-muted-foreground">
            <li>• Shared task board with live updates</li>
            <li>• Realtime presence and selected-ticket awareness</li>
            <li>• Ticket comments synchronized across browsers</li>
          </ul>
          {user ? (
            <div className="mt-8">
              <Link href="/rooms">
                <Button size="md">Go to your rooms →</Button>
              </Link>
            </div>
          ) : null}
          <p className="mt-8 text-xs text-muted-foreground">
            Note: AI coding agents are a future stage and are intentionally not
            present yet. Nothing here executes code or touches repositories.
          </p>
        </section>

        <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
          {user ? (
            <div className="space-y-4 text-center">
              <Avatar
                name={user.name ?? "You"}
                id={user.id}
                image={user.image}
                size={56}
                className="mx-auto"
              />
              <div>
                <p className="font-medium">Signed in as {user.name}</p>
                <p className="text-sm text-muted-foreground">{user.email}</p>
              </div>
              <Link href="/rooms" className="block">
                <Button className="w-full">Open rooms dashboard</Button>
              </Link>
            </div>
          ) : isDevAuthEnabled ? (
            <SignInPanel users={seedUsers} />
          ) : (
            <div className="text-sm text-muted-foreground">
              Development sign-in is disabled. Configure an authentication
              provider to sign in.
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
