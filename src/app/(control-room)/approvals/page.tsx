import Link from "next/link";

import { ApprovalCard, type ApprovalDetails } from "@/components/agentguard/approval-card";
import { PageHeader } from "@/components/agentguard/page-header";
import { Card, EmptyState, Mono } from "@/components/agentguard/primitives";
import { listPendingApprovals } from "@/lib/agents/approvals";
import { requireControlRoom } from "@/lib/dashboard/context";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const { organization, user, allows } = await requireControlRoom();
  const pending = await listPendingApprovals(organization.id);

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Runs blocked on a human decision. Approving resumes the agent; rejecting ends the run."
      />

      <div className="space-y-4 px-8 py-6">
        {!allows("approval:decide") && pending.length > 0 && (
          <p className="rounded-md border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
            You can see what is waiting, but only an Admin or Reviewer can
            resolve an approval gate.
          </p>
        )}

        {pending.length === 0 ? (
          <Card>
            <EmptyState
              title="Nothing waiting"
              description="No agent run is currently blocked on a human decision. When a run reaches a protected action, it will pause here."
            />
          </Card>
        ) : (
          <ul className="space-y-4">
            {pending.map((request) => {
              const isRequester = request.run.requestedBy?.id === user.id;
              return (
                <li key={request.id}>
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                    <Link
                      href={`/runs/${request.run.id}`}
                      className="font-medium hover:underline"
                    >
                      {request.run.task.title}
                    </Link>
                    <Mono>{request.run.targetRepositoryKey}</Mono>
                  </div>
                  <ApprovalCard
                    approvalId={request.id}
                    action={request.action}
                    summary={request.summary}
                    details={(request.detailsJson ?? {}) as ApprovalDetails}
                    requestedBy={
                      request.requestedBy?.name ??
                      request.run.requestedBy?.name ??
                      null
                    }
                    requestedAt={request.createdAt.toISOString()}
                    canDecide={allows("approval:decide") && !isRequester}
                    blockedReason={
                      isRequester
                        ? "You started this run. Approval requires a second person."
                        : "Only an Admin or Reviewer can resolve an approval gate."
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
