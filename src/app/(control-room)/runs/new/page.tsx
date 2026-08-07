import { redirect } from "next/navigation";

import { NewRunForm } from "@/components/agentguard/new-run-form";
import { PageHeader } from "@/components/agentguard/page-header";
import { Card, EmptyState } from "@/components/agentguard/primitives";
import { requireControlRoom } from "@/lib/dashboard/context";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export default async function NewRunPage() {
  const { organization, allows } = await requireControlRoom();

  // Reviewers can judge runs but not start them; send them somewhere useful
  // rather than showing a form whose submit button would be refused.
  if (!allows("run:create")) redirect("/runs");

  const [repositories, profiles] = await Promise.all([
    prisma.repositoryConnection.findMany({
      where: { roomId: organization.id, isActive: true },
      orderBy: { repo: "asc" },
      select: { id: true, owner: true, repo: true, defaultBranch: true },
    }),
    prisma.policyProfile.findMany({
      where: { OR: [{ roomId: null }, { roomId: organization.id }] },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        isDefault: true,
      },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="New run"
        description="Policies are evaluated before the run is created, and the preflight shows exactly what the agent will and will not be permitted to do."
      />

      <div className="px-8 py-6">
        {repositories.length === 0 ? (
          <Card>
            <EmptyState
              title="No repositories are enabled"
              description="Enable at least one repository for agent runs before creating one. In Demo Mode the seeded repositories appear automatically — run npm run db:seed."
            />
          </Card>
        ) : (
          <NewRunForm
            roomId={organization.id}
            repositories={repositories.map((repository) => ({
              id: repository.id,
              fullName: `${repository.owner}/${repository.repo}`,
              defaultBranch: repository.defaultBranch,
            }))}
            profiles={profiles}
          />
        )}
      </div>
    </>
  );
}
