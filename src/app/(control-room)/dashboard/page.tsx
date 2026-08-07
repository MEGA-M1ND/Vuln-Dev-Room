import Link from "next/link";

import { ActivityChart, BarBreakdown, OutcomeBar } from "@/components/agentguard/charts";
import { PageHeader } from "@/components/agentguard/page-header";
import {
  Card,
  CardHeader,
  EmptyState,
  Metric,
  Mono,
  RiskPill,
  RUN_STATUS_LABEL,
  StatusPill,
  formatRelative,
} from "@/components/agentguard/primitives";
import { Button } from "@/components/ui/button";
import { getDashboardMetrics } from "@/lib/dashboard/service";
import { requireControlRoom } from "@/lib/dashboard/context";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { organization, allows } = await requireControlRoom();
  const data = await getDashboardMetrics(organization.id);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Agent activity, policy outcomes, and audit integrity across ${organization.name}.`}
        actions={
          allows("run:create") ? (
            <Link href="/runs/new">
              <Button>New run</Button>
            </Link>
          ) : null
        }
      />

      <div className="space-y-6 px-8 py-6">
        {/* Metrics ------------------------------------------------------- */}
        <section
          aria-label="Key metrics"
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"
        >
          <Metric
            label="Active runs"
            value={data.metrics.activeRuns}
            tone="agent"
            hint="Running, queued, or paused"
          />
          <Metric
            label="Awaiting approval"
            value={data.metrics.pendingApprovals}
            tone={data.metrics.pendingApprovals > 0 ? "gate" : undefined}
            hint="Blocked on a reviewer"
          />
          <Metric
            label="Policy denials"
            value={data.metrics.policyDenials}
            tone={data.metrics.policyDenials > 0 ? "deny" : undefined}
            hint={`Last ${data.windowDays} days`}
          />
          <Metric
            label="Pull requests"
            value={data.metrics.pullRequestsCreated}
            hint="Opened by an agent, after approval"
          />
          <Metric
            label="Audit integrity"
            value={
              data.metrics.auditIntegrityRate === null
                ? null
                : `${data.metrics.auditIntegrityRate}%`
            }
            tone={
              data.metrics.auditIntegrityRate === 100 ? "allow" : undefined
            }
            hint={
              data.metrics.auditReportCount === 0
                ? "No sealed reports yet"
                : `${data.metrics.auditReportCount} sealed report${data.metrics.auditReportCount === 1 ? "" : "s"}`
            }
          />
        </section>

        {/* Charts -------------------------------------------------------- */}
        <section className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader
              title="Runs by status"
              description="Every run this organization has created."
            />
            <BarBreakdown
              emptyLabel="No runs yet."
              data={data.runsByStatus.map((row) => ({
                label: RUN_STATUS_LABEL[row.status],
                value: row.count,
                tone: row.status === "FAILED"
                  ? "bg-deny"
                  : row.status === "AWAITING_APPROVAL"
                    ? "bg-gate"
                    : row.status === "SUCCEEDED"
                      ? "bg-allow"
                      : "bg-agent",
              }))}
            />
          </Card>

          <Card>
            <CardHeader
              title="Policy outcomes"
              description={`Every evaluated action in the last ${data.windowDays} days.`}
            />
            <OutcomeBar outcomes={data.policyOutcomes} />
          </Card>

          <Card>
            <CardHeader
              title="Daily agent activity"
              description="Runs created per day, last 14 days."
            />
            <ActivityChart data={data.activityByDay} />
          </Card>
        </section>

        {/* Tables -------------------------------------------------------- */}
        <section className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader
              title="Recent runs"
              actions={
                <Link
                  href="/runs"
                  className="text-xs font-medium text-agent hover:underline"
                >
                  View all
                </Link>
              }
            />
            {data.recentRuns.length === 0 ? (
              <EmptyState
                title="No runs yet"
                description="Create a run against a connected repository to see it here."
                action={
                  allows("run:create") ? (
                    <Link href="/runs/new">
                      <Button>New run</Button>
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <ul className="divide-y divide-border">
                {data.recentRuns.map((run) => (
                  <li key={run.id}>
                    <Link
                      href={`/runs/${run.id}`}
                      className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-muted/40"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium">
                          {run.title}
                        </p>
                        <p className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                          <Mono>{run.repository}</Mono>
                          <span>{run.requestedBy}</span>
                          <span>·</span>
                          <span>{formatRelative(run.createdAt)}</span>
                        </p>
                      </div>
                      <StatusPill status={run.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Pending approvals"
              actions={
                <Link
                  href="/approvals"
                  className="text-xs font-medium text-agent hover:underline"
                >
                  Review
                </Link>
              }
            />
            {data.pendingApprovalRows.length === 0 ? (
              <EmptyState
                title="Nothing waiting"
                description="No agent run is currently blocked on a human decision."
              />
            ) : (
              <ul className="divide-y divide-border">
                {data.pendingApprovalRows.map((row) => (
                  <li key={row.id}>
                    <Link
                      href={`/runs/${row.runId}`}
                      className="block px-5 py-3 transition-colors hover:bg-muted/40"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 truncate text-xs font-medium">
                          {row.title}
                        </p>
                        <RiskPill level={row.riskLevel} />
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {row.summary}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {row.requestedBy} · {formatRelative(row.createdAt)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        <section className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader
              title="Recent policy denials"
              description="Actions the rule set refused. Each names the rule that decided."
            />
            {data.recentDenials.length === 0 ? (
              <EmptyState
                title="No denials"
                description="No agent action has been refused by policy."
              />
            ) : (
              <ul className="divide-y divide-border">
                {data.recentDenials.map((row) => (
                  <li key={row.id} className="px-5 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-xs font-medium">
                          <span className="text-deny">{row.action}</span>
                          {typeof row.resource?.path === "string" && (
                            <Mono>{row.resource.path}</Mono>
                          )}
                          {typeof row.resource?.branch === "string" && (
                            <Mono>{row.resource.branch}</Mono>
                          )}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {row.reason}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Rule: {row.policy}
                          {row.title ? ` · ${row.title}` : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatRelative(row.createdAt)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Top repositories"
              description="By agent run volume."
            />
            {data.topRepositories.length === 0 ? (
              <EmptyState
                title="No activity"
                description="No runs have been created against any repository."
              />
            ) : (
              <BarBreakdown
                data={data.topRepositories.map((row) => ({
                  label: row.repository.split("/").pop() ?? row.repository,
                  value: row.runs,
                  tone: "bg-tool",
                }))}
              />
            )}
          </Card>
        </section>
      </div>
    </>
  );
}
