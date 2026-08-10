import Link from "next/link";
import { notFound } from "next/navigation";

import { ApprovalCard, type ApprovalDetails } from "@/components/agentguard/approval-card";
import { PageHeader } from "@/components/agentguard/page-header";
import {
  Card,
  CardHeader,
  EmptyState,
  Mono,
  OutcomePill,
  Pill,
  RiskPill,
  RUN_MODE_LABEL,
  StatusPill,
  formatDuration,
  formatRelative,
} from "@/components/agentguard/primitives";
import { RunControls } from "@/components/agentguard/run-controls";
import { RunTimeline } from "@/components/agentguard/run-timeline";
import { Button } from "@/components/ui/button";
import { requireControlRoom } from "@/lib/dashboard/context";
import { prisma } from "@/lib/db/client";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ runId: string }> };

export default async function RunDetailPage({ params }: Params) {
  const { runId } = await params;
  const { organization, user, allows } = await requireControlRoom();

  const run = await prisma.agentRun.findFirst({
    // Scoped to the caller's organization: a run id from another org must read
    // as "not found", never as "forbidden", which would confirm it exists.
    where: { id: runId, roomId: organization.id },
    include: {
      task: true,
      requestedBy: { select: { id: true, name: true } },
      owner: { select: { id: true, name: true } },
      policyProfile: { select: { id: true, key: true, name: true, description: true } },
      artifacts: { orderBy: { sequence: "asc" } },
      pullRequest: true,
    },
  });

  if (!run) notFound();

  const [events, decisions, approvals, activePolicies] = await Promise.all([
    prisma.runEvent.findMany({
      where: { runId },
      orderBy: { sequence: "asc" },
    }),
    prisma.policyDecision.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
      include: { policy: { select: { name: true } } },
    }),
    prisma.approvalRequest.findMany({
      where: { runId },
      orderBy: { createdAt: "desc" },
      include: {
        decisions: {
          orderBy: { createdAt: "asc" },
          include: { reviewer: { select: { name: true } } },
        },
        requestedBy: { select: { name: true } },
      },
    }),
    prisma.policy.findMany({
      where: {
        enabled: true,
        OR: [
          { roomId: null, policyProfileId: null },
          { roomId: organization.id, policyProfileId: null },
          ...(run.policyProfileId ? [{ policyProfileId: run.policyProfileId }] : []),
        ],
      },
      orderBy: { priority: "asc" },
      select: { id: true, name: true, effect: true, message: true },
    }),
  ]);

  const pending = approvals.find((a) => a.status === "PENDING");
  const diff = [...run.artifacts].reverse().find((a) => a.type === "DIFF");
  const tests = [...run.artifacts].reverse().find((a) => a.type === "TEST_RESULT");
  const plan = run.artifacts.find((a) => a.type === "PLAN");

  // Self-approval is refused server-side; say so here rather than letting a
  // reviewer discover it by pressing the button.
  const isRequester = run.requestedById === user.id;
  const canDecide = allows("approval:decide") && !isRequester;
  const blockedReason = isRequester
    ? "You started this run. Approval requires a second person."
    : "Only an Admin or Reviewer can resolve an approval gate.";

  const durationMs =
    run.startedAt && run.finishedAt
      ? run.finishedAt.getTime() - run.startedAt.getTime()
      : null;

  return (
    <>
      <PageHeader
        title={run.task.title}
        description={run.task.objective ?? run.task.description ?? undefined}
        actions={
          <>
            <RunControls
              runId={run.id}
              status={run.status}
              canSimulate={allows("run:simulate")}
              canCancel={allows("run:cancel")}
            />
            <Link href={`/evidence/${run.id}`}>
              <Button variant="secondary">Evidence report</Button>
            </Link>
          </>
        }
      />

      {/* Summary bar ------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-8 py-3 text-xs">
        <StatusPill status={run.status} />
        <RiskPill level={run.riskLevel} />
        <Meta label="Repository">
          <Mono>{run.targetRepositoryKey}</Mono>
        </Meta>
        <Meta label="Branch">
          <Mono>{run.workingBranch ?? run.baseBranch}</Mono>
          {run.workingBranch && (
            <>
              <span className="mx-1 text-muted-foreground">→</span>
              <Mono>{run.baseBranch}</Mono>
            </>
          )}
        </Meta>
        <Meta label="Mode">{RUN_MODE_LABEL[run.mode]}</Meta>
        <Meta label="Agent">{run.agentId}</Meta>
        <Meta label="Owner">{run.owner?.name ?? run.requestedBy.name}</Meta>
        {durationMs !== null && (
          <Meta label="Duration">{formatDuration(durationMs)}</Meta>
        )}
      </div>

      <div className="grid gap-6 px-8 py-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          {/* Approval gate ------------------------------------------------ */}
          {pending && (
            <ApprovalCard
              approvalId={pending.id}
              action={pending.action}
              summary={pending.summary}
              details={(pending.detailsJson ?? {}) as ApprovalDetails}
              requestedBy={pending.requestedBy?.name ?? null}
              requestedAt={pending.createdAt.toISOString()}
              canDecide={canDecide}
              blockedReason={blockedReason}
            />
          )}

          {run.errorSummary && !pending && (
            <div className="rounded-lg border border-deny/40 bg-deny/[0.06] px-5 py-4">
              <p className="text-xs font-semibold text-deny">
                {run.errorCode === "POLICY_DENIED"
                  ? "Stopped by policy"
                  : run.errorCode === "APPROVAL_REJECTED"
                    ? "Rejected by reviewer"
                    : "Run failed"}
              </p>
              <p className="mt-1 text-[11px] text-foreground/80">
                {run.errorSummary}
              </p>
            </div>
          )}

          {/* Timeline ----------------------------------------------------- */}
          <Card className="flex h-[32rem] flex-col overflow-hidden">
            <RunTimeline
              runId={run.id}
              initialStatus={run.status}
              initialEvents={events.map((event) => ({
                id: event.id,
                sequence: event.sequence,
                type: event.type,
                actorType: event.actorType,
                actorId: event.actorId,
                payload: event.payloadJson as Record<string, unknown> | null,
                createdAt: event.createdAt.toISOString(),
                eventHash: event.eventHash,
              }))}
            />
          </Card>

          {/* Changes ------------------------------------------------------ */}
          <Card>
            <CardHeader
              title="Changes"
              description={
                diff
                  ? "The diff the agent proposes. Nothing is applied to a protected branch."
                  : undefined
              }
            />
            {diff?.contentText ? (
              <pre className="max-h-96 overflow-auto px-5 py-4 font-mono text-[11px] leading-relaxed">
                {diff.contentText.split("\n").map((line, index) => (
                  <div
                    key={index}
                    className={cn(
                      line.startsWith("+") && !line.startsWith("+++")
                        ? "text-allow"
                        : line.startsWith("-") && !line.startsWith("---")
                          ? "text-deny"
                          : line.startsWith("@@")
                            ? "text-tool"
                            : "text-muted-foreground",
                    )}
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
            ) : (
              <EmptyState
                title="No diff captured"
                description="This run has not produced a change. Plan-only and verification runs never do."
              />
            )}
          </Card>

          {/* Tests + Plan -------------------------------------------------- */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Tests" />
              {tests?.contentJson ? (
                <TestResults data={tests.contentJson as Record<string, unknown>} />
              ) : (
                <EmptyState
                  title="No test results"
                  description="No verification suite has run for this task yet."
                />
              )}
            </Card>

            <Card>
              <CardHeader title="Plan" />
              {plan?.contentJson ? (
                <PlanView data={plan.contentJson as Record<string, unknown>} />
              ) : (
                <EmptyState
                  title="No plan"
                  description="The agent has not produced a plan for this run."
                />
              )}
            </Card>
          </div>

          {/* Approval history --------------------------------------------- */}
          {approvals.filter((a) => a.status !== "PENDING").length > 0 && (
            <Card>
              <CardHeader title="Approval history" />
              <ul className="divide-y divide-border">
                {approvals
                  .filter((a) => a.status !== "PENDING")
                  .map((approval) => (
                    <li key={approval.id} className="px-5 py-3 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill
                          className={
                            approval.status === "APPROVED"
                              ? "border-allow/40 bg-allow/10 text-allow"
                              : approval.status === "REJECTED"
                                ? "border-deny/40 bg-deny/10 text-deny"
                                : "border-border text-muted-foreground"
                          }
                        >
                          {approval.status.toLowerCase()}
                        </Pill>
                        <span className="text-muted-foreground">
                          {approval.action}
                        </span>
                        <span className="ml-auto text-[11px] text-muted-foreground">
                          {formatRelative(
                            (approval.resolvedAt ?? approval.createdAt).toISOString(),
                          )}
                        </span>
                      </div>
                      {approval.decisions.map((decision) => (
                        <p
                          key={decision.id}
                          className="mt-1.5 text-[11px] text-muted-foreground"
                        >
                          <span className="text-foreground/80">
                            {decision.reviewer.name}
                          </span>{" "}
                          {decision.decision === "APPROVE"
                            ? "approved"
                            : "rejected"}
                          {decision.comment && ` — “${decision.comment}”`}
                        </p>
                      ))}
                    </li>
                  ))}
              </ul>
            </Card>
          )}
        </div>

        {/* Policy panel --------------------------------------------------- */}
        <aside className="space-y-6 xl:sticky xl:top-6 xl:self-start">
          <Card>
            <CardHeader
              title="Policy"
              description={run.policyProfile?.name ?? "No profile assigned"}
            />
            {run.policyProfile && (
              <p className="border-b border-border px-5 py-3 text-[11px] leading-relaxed text-muted-foreground">
                {run.policyProfile.description}
              </p>
            )}
            <ul className="divide-y divide-border">
              {activePolicies.map((policy) => (
                <li
                  key={policy.id}
                  className="flex items-start gap-2 px-5 py-2.5 text-[11px]"
                >
                  <span
                    className={cn(
                      "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                      policy.effect === "DENY"
                        ? "bg-deny"
                        : policy.effect === "REQUIRE_APPROVAL"
                          ? "bg-gate"
                          : "bg-allow",
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block text-foreground/85">
                      {policy.name}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="border-t border-border px-5 py-3">
              <Link
                href="/policies"
                className="text-[11px] font-medium text-agent hover:underline"
              >
                Manage policies
              </Link>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Policy decisions"
              description={`${decisions.length} evaluated`}
            />
            {decisions.length === 0 ? (
              <EmptyState
                title="Nothing evaluated yet"
                description="Decisions appear as the agent attempts governed actions."
              />
            ) : (
              <ul className="max-h-80 divide-y divide-border overflow-y-auto">
                {decisions.map((decision) => (
                  <li key={decision.id} className="px-5 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[11px] font-medium">
                        {decision.action}
                      </span>
                      <OutcomePill outcome={decision.outcome} />
                    </div>
                    <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                      {decision.policy?.name ?? "Default posture"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {run.pullRequest && (
            <Card>
              <CardHeader title="Delivery" />
              <div className="space-y-2 px-5 py-4 text-[11px]">
                <p className="flex items-center gap-2">
                  <Pill className="border-allow/40 bg-allow/10 text-allow">
                    {run.pullRequest.state}
                  </Pill>
                  <span className="text-muted-foreground">
                    #{run.pullRequest.number}
                  </span>
                </p>
                <p className="break-all text-muted-foreground">
                  {run.pullRequest.url}
                </p>
                {run.pullRequest.provider === "SIMULATED" && (
                  <p className="text-muted-foreground">
                    Simulated in Demo Mode. No pull request was created on
                    GitHub.
                  </p>
                )}
              </div>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}

function Meta({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span>{children}</span>
    </span>
  );
}

function TestResults({ data }: { data: Record<string, unknown> }) {
  const passed = Number(data.passed ?? 0);
  const total = Number(data.total ?? 0);
  const failed = Number(data.failed ?? 0);
  const suites = Array.isArray(data.suites) ? data.suites : [];

  return (
    <div className="px-5 py-4">
      <p className="flex items-baseline gap-2">
        <span
          className={cn(
            "ag-numeric text-xl font-semibold",
            failed > 0 ? "text-deny" : "text-allow",
          )}
        >
          {passed}/{total}
        </span>
        <span className="text-xs text-muted-foreground">passing</span>
      </p>
      {typeof data.command === "string" && (
        <p className="mt-2">
          <Mono>{data.command}</Mono>
        </p>
      )}
      {suites.length > 0 && (
        <ul className="mt-3 space-y-1">
          {suites.map((suite, index) => {
            const row = suite as { name?: string; passed?: number; failed?: number };
            return (
              <li
                key={index}
                className="flex items-center justify-between text-[11px]"
              >
                <span className="truncate text-muted-foreground">
                  {row.name}
                </span>
                <span
                  className={cn(
                    "ag-numeric",
                    (row.failed ?? 0) > 0 ? "text-deny" : "text-allow",
                  )}
                >
                  {row.passed ?? 0}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PlanView({ data }: { data: Record<string, unknown> }) {
  const summary = typeof data.summary === "string" ? data.summary : null;
  const steps = Array.isArray(data.steps) ? data.steps : [];

  return (
    <div className="px-5 py-4 text-xs">
      {summary && <p className="text-foreground/85">{summary}</p>}
      {steps.length > 0 && (
        <ol className="mt-3 space-y-1.5">
          {steps.map((step, index) => (
            <li key={index} className="flex gap-2 text-[11px]">
              <span className="ag-numeric shrink-0 text-muted-foreground">
                {index + 1}.
              </span>
              <span className="text-foreground/80">{String(step)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
