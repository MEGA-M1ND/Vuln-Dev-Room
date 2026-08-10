import Link from "next/link";

import { PageHeader } from "@/components/agentguard/page-header";
import {
  Card,
  EmptyState,
  Mono,
  RiskPill,
  RUN_MODE_LABEL,
  StatusPill,
  formatDuration,
  formatRelative,
} from "@/components/agentguard/primitives";
import { Button } from "@/components/ui/button";
import { requireControlRoom } from "@/lib/dashboard/context";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const { organization, allows } = await requireControlRoom();

  const runs = await prisma.agentRun.findMany({
    where: { roomId: organization.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      status: true,
      mode: true,
      riskLevel: true,
      targetRepositoryKey: true,
      baseBranch: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      agentId: true,
      task: { select: { title: true } },
      requestedBy: { select: { name: true } },
      policyProfile: { select: { name: true } },
      _count: { select: { approvalRequests: true } },
    },
  });

  return (
    <>
      <PageHeader
        title="Runs"
        description="Every governed agent run, newest first."
        actions={
          allows("run:create") ? (
            <Link href="/runs/new">
              <Button>New run</Button>
            </Link>
          ) : null
        }
      />

      <div className="px-8 py-6">
        <Card>
          {runs.length === 0 ? (
            <EmptyState
              title="No runs yet"
              description="Create a run against a connected repository. It will be governed by the policy profile you choose, and paused for approval before anything is delivered."
              action={
                allows("run:create") ? (
                  <Link href="/runs/new">
                    <Button>New run</Button>
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[54rem] text-left text-xs">
                <thead className="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-5 py-3 font-medium">Task</th>
                    <th scope="col" className="px-5 py-3 font-medium">Repository</th>
                    <th scope="col" className="px-5 py-3 font-medium">Mode</th>
                    <th scope="col" className="px-5 py-3 font-medium">Risk</th>
                    <th scope="col" className="px-5 py-3 font-medium">Status</th>
                    <th scope="col" className="px-5 py-3 font-medium">Duration</th>
                    <th scope="col" className="px-5 py-3 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {runs.map((run) => (
                    <tr
                      key={run.id}
                      className="transition-colors hover:bg-muted/40"
                    >
                      <td className="max-w-xs px-5 py-3">
                        <Link
                          href={`/runs/${run.id}`}
                          className="block truncate font-medium hover:underline"
                        >
                          {run.task.title}
                        </Link>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {run.requestedBy.name}
                          {run.policyProfile
                            ? ` · ${run.policyProfile.name}`
                            : ""}
                        </p>
                      </td>
                      <td className="px-5 py-3">
                        <Mono>{run.targetRepositoryKey}</Mono>
                      </td>
                      <td className="px-5 py-3 text-muted-foreground">
                        {RUN_MODE_LABEL[run.mode]}
                      </td>
                      <td className="px-5 py-3">
                        <RiskPill level={run.riskLevel} />
                      </td>
                      <td className="px-5 py-3">
                        <StatusPill status={run.status} />
                      </td>
                      <td className="ag-numeric px-5 py-3 text-muted-foreground">
                        {formatDuration(
                          run.startedAt && run.finishedAt
                            ? run.finishedAt.getTime() - run.startedAt.getTime()
                            : null,
                        )}
                      </td>
                      <td className="px-5 py-3 text-muted-foreground">
                        {formatRelative(run.createdAt.toISOString())}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
