import { PageHeader } from "@/components/agentguard/page-header";
import {
  Card,
  CardHeader,
  EmptyState,
  Mono,
  Pill,
} from "@/components/agentguard/primitives";
import { Button } from "@/components/ui/button";
import { env, isGitHubConfigured } from "@/env";
import { requireControlRoom } from "@/lib/dashboard/context";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/**
 * Permissions the integration asks for, stated in full.
 *
 * The refusals matter more than the grants here: "no merge access" is the
 * product's central claim, and burying it would make this page a permissions
 * list rather than a security statement.
 */
const PERMISSIONS = [
  { label: "Read source code", granted: true, note: "Clone and inspect the repository at a given ref." },
  { label: "Read issues and pull requests", granted: true, note: "Link a run to the issue it addresses." },
  { label: "Create branches and pull requests", granted: true, note: "Only after a reviewer approves the gate." },
  {
    label: "Merge to a default branch",
    granted: false,
    note: "Never requested. There is no merge call anywhere in this product.",
  },
  {
    label: "Read repository or organization secrets",
    granted: false,
    note: "Never requested, and separately denied by the secret-access policy.",
  },
  {
    label: "Administer the repository or organization",
    granted: false,
    note: "Never requested.",
  },
] as const;

export default async function RepositoriesPage() {
  const { organization } = await requireControlRoom();

  const [connection, repositories] = await Promise.all([
    prisma.gitHubConnection.findUnique({
      where: { roomId: organization.id },
      select: {
        accountLogin: true,
        createdAt: true,
        createdBy: { select: { name: true } },
      },
    }),
    prisma.repositoryConnection.findMany({
      where: { roomId: organization.id },
      orderBy: { repo: "asc" },
    }),
  ]);

  const demo = !isGitHubConfigured;

  return (
    <>
      <PageHeader
        title="Repositories"
        description="Repositories this organization has enabled for agent runs."
        actions={
          demo ? (
            <Button variant="secondary" disabled title="Configure GITHUB_TOKEN or the GitHub App to enable">
              Connect GitHub
            </Button>
          ) : null
        }
      />

      <div className="space-y-6 px-8 py-6">
        {demo && (
          <div className="rounded-lg border border-gate/40 bg-gate/[0.06] px-5 py-4">
            <p className="text-sm font-semibold text-gate">Demo Mode</p>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-foreground/80">
              {env.DEVROOM_GITHUB_ENABLED
                ? "GitHub is enabled but no valid token is configured on the server, so the app fell back to seeded repositories."
                : "No GitHub credentials are configured, so the repositories below are seeded and agent execution is simulated."}{" "}
              Everything else is real: policies are evaluated by the live rule
              set, approval gates block in the database, and the audit trail is
              hash-chained exactly as it would be against a real repository.
            </p>
          </div>
        )}

        {connection && (
          <Card>
            <CardHeader title="Connection" />
            <dl className="grid gap-x-8 gap-y-2 px-5 py-4 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Account</dt>
                <dd className="mt-0.5">
                  <Mono>{connection.accountLogin}</Mono>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Connected</dt>
                <dd className="mt-0.5">
                  {connection.createdAt.toLocaleDateString()}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">By</dt>
                <dd className="mt-0.5">{connection.createdBy?.name ?? "—"}</dd>
              </div>
            </dl>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <Card>
            <CardHeader
              title="Enabled repositories"
              description="An agent run can only target a repository listed here."
            />
            {repositories.length === 0 ? (
              <EmptyState
                title="No repositories"
                description="Run npm run db:seed to load the demo repositories, or connect GitHub."
              />
            ) : (
              <ul className="divide-y divide-border">
                {repositories.map((repository) => (
                  <li
                    key={repository.id}
                    className="flex flex-wrap items-start justify-between gap-3 px-5 py-4"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium">
                        <Mono>
                          {repository.owner}/{repository.repo}
                        </Mono>
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Default branch{" "}
                        <Mono>{repository.defaultBranch}</Mono>
                      </p>
                      {repository.criticalPaths.length > 0 && (
                        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span>Critical paths:</span>
                          {repository.criticalPaths.map((path) => (
                            <Mono key={path}>{path}</Mono>
                          ))}
                        </p>
                      )}
                    </div>
                    <Pill
                      className={
                        repository.isActive
                          ? "border-allow/40 bg-allow/10 text-allow"
                          : "border-border text-muted-foreground"
                      }
                    >
                      {repository.isActive ? "Enabled" : "Disabled"}
                    </Pill>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="self-start">
            <CardHeader
              title="Access this integration requests"
              description="Scoped per repository, with short-lived credentials."
            />
            <ul className="divide-y divide-border">
              {PERMISSIONS.map((permission) => (
                <li key={permission.label} className="flex gap-3 px-5 py-3">
                  <span
                    className={
                      permission.granted
                        ? "mt-0.5 text-allow"
                        : "mt-0.5 text-deny"
                    }
                    aria-hidden="true"
                  >
                    {permission.granted ? "✓" : "✕"}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">
                      {permission.label}
                      <span className="sr-only">
                        {permission.granted ? " — granted" : " — not requested"}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                      {permission.note}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="border-t border-border px-5 py-3 text-[11px] leading-relaxed text-muted-foreground">
              Credentials are held server-side and never sent to the browser.
              Nothing on this page, or any other, exposes a token or
              installation id.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
