import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { isDevAuthEnabled, isGitHubOAuthConfigured } from "@/env";
import { prisma } from "@/lib/db/client";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { SignInPanel } from "@/components/auth/sign-in-panel";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { GitHubSignInButton } from "@/components/auth/github-sign-in-button";

export default async function HomePage() {
  const user = await getCurrentUser();

  // A signed-in member belongs in the control room, not on a sign-in screen.
  // Checked here rather than in middleware so the redirect depends on actual
  // membership, which middleware cannot query.
  if (user) {
    const membership = await prisma.roomMembership.findFirst({
      where: { userId: user.id },
      select: { id: true },
    });
    if (membership) redirect("/dashboard");
  }

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
          <svg
            viewBox="0 0 24 24"
            className="h-8 w-8 text-agent"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 2.5 4.5 5.5v6c0 4.6 3.2 8.9 7.5 10 4.3-1.1 7.5-5.4 7.5-10v-6L12 2.5Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <span className="text-lg font-semibold">AgentGuard Control Room</span>
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
            Governance for AI coding agents
          </span>
          <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">
            Agent work you can actually supervise.
          </h1>
          <p className="mt-4 max-w-prose text-muted-foreground">
            Coding agents mostly run invisibly inside one developer&rsquo;s
            terminal. AgentGuard puts a control plane around them: explicit
            policy before execution, a live view of what the agent is doing, a
            human approval gate before any pull request, and a tamper-evident
            record afterwards.
          </p>
          <ul className="mt-6 grid gap-2 text-sm text-muted-foreground">
            <li>• Policy evaluated before every governed action</li>
            <li>• Live event timeline: plans, tool calls, tests, decisions</li>
            <li>• Approval gate a requester cannot grant themselves</li>
            <li>• Hash-chained audit trail and downloadable evidence</li>
          </ul>
          {user ? (
            <div className="mt-8">
              <Link href="/dashboard">
                <Button size="md">Open the control room →</Button>
              </Link>
            </div>
          ) : null}
          <p className="mt-8 max-w-prose text-xs text-muted-foreground">
            Agent execution is simulated in V1: nothing here runs a shell command
            or merges anything. The control plane around it &mdash; policy,
            gating, and audit &mdash; is real.
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
              <Link href="/dashboard" className="block">
                <Button className="w-full">Open the control room</Button>
              </Link>
            </div>
          ) : isDevAuthEnabled ? (
            <SignInPanel users={seedUsers} />
          ) : isGitHubOAuthConfigured ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Sign in to AgentGuard</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Sign in with your GitHub account to continue.
                </p>
              </div>
              <GitHubSignInButton />
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              Sign-in is not configured. Set up an authentication provider to
              sign in.
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
