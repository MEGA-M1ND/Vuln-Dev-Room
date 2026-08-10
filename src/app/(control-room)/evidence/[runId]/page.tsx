import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/agentguard/page-header";
import {
  Card,
  CardHeader,
  Mono,
  OutcomePill,
  Pill,
  RiskPill,
  RUN_MODE_LABEL,
  formatDuration,
} from "@/components/agentguard/primitives";
import { Button } from "@/components/ui/button";
import { requireControlRoom } from "@/lib/dashboard/context";
import { prisma } from "@/lib/db/client";
import {
  buildEvidenceBundle,
  INTEGRITY_STATEMENT,
} from "@/lib/evidence/service";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ runId: string }> };

export default async function EvidencePage({ params }: Params) {
  const { runId } = await params;
  const { organization } = await requireControlRoom();

  // Organization scope first, so a run id from elsewhere reads as not-found.
  const owned = await prisma.agentRun.findFirst({
    where: { id: runId, roomId: organization.id },
    select: { id: true },
  });
  if (!owned) notFound();

  const [bundle, sealed] = await Promise.all([
    buildEvidenceBundle(runId),
    prisma.evidenceReport.findUnique({ where: { runId } }),
  ]);
  if (!bundle) notFound();

  const run = bundle.run as Record<string, unknown>;
  const integrity = bundle.integrity;
  const complete = bundle.completeness.complete;

  return (
    <>
      <PageHeader
        title="Evidence report"
        description={String(bundle.task.title ?? "")}
        actions={
          <>
            <Link href={`/runs/${runId}`}>
              <Button variant="secondary">Back to run</Button>
            </Link>
            <a href={`/api/runs/${runId}/evidence/download`} download>
              <Button>Download JSON</Button>
            </a>
          </>
        }
      />

      <div className="mx-auto max-w-5xl space-y-6 px-8 py-6">
        {/* Integrity ------------------------------------------------------ */}
        <div
          className={cn(
            "ag-print-block rounded-lg border px-5 py-4",
            integrity.valid
              ? "border-allow/40 bg-allow/[0.06]"
              : "border-deny/40 bg-deny/[0.08]",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p
              className={cn(
                "text-sm font-semibold",
                integrity.valid ? "text-allow" : "text-deny",
              )}
            >
              {integrity.valid ? "Audit trail verified" : "Integrity check failed"}
            </p>
            <div className="flex items-center gap-2">
              <Pill
                className={
                  complete
                    ? "border-allow/40 bg-allow/10 text-allow"
                    : "border-gate/40 bg-gate/10 text-gate"
                }
              >
                {complete ? "Evidence complete" : "Evidence incomplete"}
              </Pill>
              <RiskPill level={run.riskLevel as "LOW" | "MEDIUM" | "HIGH"} />
            </div>
          </div>

          <p className="mt-2 text-xs text-foreground/85">{integrity.summary}</p>

          {!complete && (
            <ul className="mt-2 list-inside list-disc text-[11px] text-muted-foreground">
              {bundle.completeness.missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}

          {integrity.chainHead && (
            <p className="mt-3 break-all text-[10px] text-muted-foreground">
              <span className="uppercase tracking-wider">Chain head</span>{" "}
              <span className="font-mono">{integrity.chainHead}</span>
            </p>
          )}

          {sealed && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              Sealed {sealed.generatedAt.toLocaleString()} over{" "}
              <span className="ag-numeric">{sealed.eventCount}</span> events
              {sealed.chainHead !== integrity.chainHead && (
                <>
                  {" "}
                  — the live chain has since extended, which is expected: the
                  seal itself is recorded on the trail.
                </>
              )}
            </p>
          )}

          <p className="mt-3 border-t border-border/60 pt-3 text-[11px] leading-relaxed text-muted-foreground">
            {INTEGRITY_STATEMENT}
          </p>
        </div>

        {/* Metadata ------------------------------------------------------- */}
        <Card className="ag-print-block">
          <CardHeader title="Run metadata" />
          <dl className="grid gap-x-8 gap-y-3 px-5 py-4 text-xs sm:grid-cols-3">
            <Field label="Run ID">
              <Mono>{String(run.id)}</Mono>
            </Field>
            <Field label="Status">{String(run.status)}</Field>
            <Field label="Mode">
              {RUN_MODE_LABEL[run.mode as keyof typeof RUN_MODE_LABEL]}
            </Field>
            <Field label="Organization">{String(run.organization)}</Field>
            <Field label="Repository">
              <Mono>{String(run.repository)}</Mono>
            </Field>
            <Field label="Agent">{String(run.agent)}</Field>
            <Field label="Base branch">
              <Mono>{String(run.baseBranch)}</Mono>
            </Field>
            <Field label="Working branch">
              {run.workingBranch ? <Mono>{String(run.workingBranch)}</Mono> : "—"}
            </Field>
            <Field label="Requested by">
              {(run.requestedBy as { name?: string } | null)?.name ?? "—"}
            </Field>
            <Field label="Created">
              {new Date(String(run.createdAt)).toLocaleString()}
            </Field>
            <Field label="Finished">
              {run.finishedAt
                ? new Date(String(run.finishedAt)).toLocaleString()
                : "—"}
            </Field>
            <Field label="Duration">
              {formatDuration(run.durationMs as number | null)}
            </Field>
          </dl>
        </Card>

        {/* Task ----------------------------------------------------------- */}
        <Card className="ag-print-block">
          <CardHeader title="Task" />
          <div className="space-y-3 px-5 py-4 text-xs">
            <p className="font-medium">{String(bundle.task.title)}</p>
            {bundle.task.objective ? (
              <p className="text-foreground/80">{String(bundle.task.objective)}</p>
            ) : null}
            {bundle.task.acceptanceCriteria ? (
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Acceptance criteria
                </p>
                <p className="mt-1 text-foreground/80">
                  {String(bundle.task.acceptanceCriteria)}
                </p>
              </div>
            ) : null}
          </div>
        </Card>

        {/* Policy --------------------------------------------------------- */}
        <Card className="ag-print-block">
          <CardHeader
            title="Policy"
            description={
              (bundle.policy.profile as { name?: string } | null)?.name ??
              "No profile assigned"
            }
          />
          <div className="grid gap-4 px-5 py-4 text-xs sm:grid-cols-4">
            <Stat label="Evaluated" value={Number(bundle.policy.evaluated)} />
            <Stat
              label="Allowed"
              value={Number(bundle.policy.allowed)}
              tone="text-allow"
            />
            <Stat
              label="Approval required"
              value={Number(bundle.policy.approvalRequired)}
              tone="text-gate"
            />
            <Stat
              label="Denied"
              value={Number(bundle.policy.denied)}
              tone="text-deny"
            />
          </div>

          {bundle.policyDecisions.length > 0 && (
            <ul className="divide-y divide-border border-t border-border">
              {bundle.policyDecisions.map((decision, index) => {
                const row = decision as {
                  action: string;
                  outcome: "ALLOWED" | "APPROVAL_REQUIRED" | "DENIED";
                  reason: string;
                  policy: { name: string } | null;
                  at: string;
                };
                return (
                  <li
                    key={index}
                    className="flex flex-wrap items-start justify-between gap-3 px-5 py-2.5 text-[11px]"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">{row.action}</p>
                      <p className="mt-0.5 text-muted-foreground">
                        {row.reason}
                      </p>
                      <p className="mt-0.5 text-muted-foreground">
                        {row.policy?.name ?? "Default posture"}
                      </p>
                    </div>
                    <OutcomePill outcome={row.outcome} />
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Approvals ------------------------------------------------------ */}
        <Card className="ag-print-block">
          <CardHeader title="Approval history" />
          {bundle.approvals.length === 0 ? (
            <p className="px-5 py-6 text-center text-xs text-muted-foreground">
              No approval was requested for this run.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {bundle.approvals.map((approval, index) => {
                const row = approval as {
                  action: string;
                  status: string;
                  summary: string;
                  requestedBy: string | null;
                  requestedAt: string;
                  decisions: {
                    decision: string;
                    reviewer: string;
                    comment: string | null;
                    at: string;
                  }[];
                };
                return (
                  <li key={index} className="px-5 py-4 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill
                        className={
                          row.status === "APPROVED"
                            ? "border-allow/40 bg-allow/10 text-allow"
                            : row.status === "REJECTED"
                              ? "border-deny/40 bg-deny/10 text-deny"
                              : "border-gate/40 bg-gate/10 text-gate"
                        }
                      >
                        {row.status.toLowerCase()}
                      </Pill>
                      <span className="text-muted-foreground">{row.action}</span>
                    </div>
                    <p className="mt-1.5">{row.summary}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Requested by {row.requestedBy ?? "—"} on{" "}
                      {new Date(row.requestedAt).toLocaleString()}
                    </p>
                    {row.decisions.map((decision, decisionIndex) => (
                      <p
                        key={decisionIndex}
                        className="mt-1.5 border-l-2 border-border pl-3 text-[11px]"
                      >
                        <span className="font-medium">{decision.reviewer}</span>{" "}
                        {decision.decision === "APPROVE"
                          ? "approved"
                          : "rejected"}{" "}
                        on {new Date(decision.at).toLocaleString()}
                        {decision.comment && (
                          <span className="block italic text-muted-foreground">
                            “{decision.comment}”
                          </span>
                        )}
                      </p>
                    ))}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Tests + diff --------------------------------------------------- */}
        {bundle.tests && (
          <Card className="ag-print-block">
            <CardHeader title="Tests" />
            <div className="px-5 py-4 text-xs">
              <p className="ag-numeric">
                <span className="text-allow">
                  {String(bundle.tests.passed ?? 0)}
                </span>
                /{String(bundle.tests.total ?? 0)} passing
                {Number(bundle.tests.failed ?? 0) > 0 && (
                  <span className="ml-2 text-deny">
                    {String(bundle.tests.failed)} failed
                  </span>
                )}
              </p>
              {typeof bundle.tests.command === "string" && (
                <p className="mt-2">
                  <Mono>{bundle.tests.command}</Mono>
                </p>
              )}
            </div>
          </Card>
        )}

        {bundle.diff.text && (
          <Card className="ag-print-block">
            <CardHeader
              title="Proposed change"
              description={
                bundle.diff.stat
                  ? `${bundle.diff.stat.filesChanged} file(s), +${bundle.diff.stat.additions} −${bundle.diff.stat.deletions}`
                  : undefined
              }
            />
            <pre className="max-h-[32rem] overflow-auto px-5 py-4 font-mono text-[11px] leading-relaxed">
              {bundle.diff.text.split("\n").map((line, index) => (
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
          </Card>
        )}

        {/* Pull request --------------------------------------------------- */}
        {bundle.pullRequest && (
          <Card className="ag-print-block">
            <CardHeader title="Pull request" />
            <dl className="grid gap-x-8 gap-y-2 px-5 py-4 text-xs sm:grid-cols-2">
              <Field label="Number">#{String(bundle.pullRequest.number)}</Field>
              <Field label="State">{String(bundle.pullRequest.state)}</Field>
              <Field label="Branches">
                <Mono>{String(bundle.pullRequest.headBranch)}</Mono> →{" "}
                <Mono>{String(bundle.pullRequest.baseBranch)}</Mono>
              </Field>
              <Field label="URL">
                <span className="break-all">
                  {String(bundle.pullRequest.url)}
                </span>
              </Field>
            </dl>
            {bundle.pullRequest.provider === "SIMULATED" && (
              <p className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">
                Simulated in Demo Mode. No pull request was created on GitHub.
              </p>
            )}
          </Card>
        )}

        {/* Timeline ------------------------------------------------------- */}
        <Card className="ag-print-block">
          <CardHeader
            title="Full event timeline"
            description={`${bundle.timeline.length} hash-chained events`}
          />
          <ol className="divide-y divide-border">
            {bundle.timeline.map((event, index) => {
              const row = event as {
                sequence: number;
                type: string;
                actorType: string;
                createdAt: string;
                eventHash: string | null;
                payload: Record<string, unknown> | null;
              };
              const message =
                typeof row.payload?.message === "string"
                  ? row.payload.message
                  : null;
              return (
                <li key={index} className="flex gap-3 px-5 py-2.5 text-[11px]">
                  <span className="ag-numeric w-8 shrink-0 text-muted-foreground">
                    {row.sequence}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{row.type}</span>
                    {message && (
                      <span className="ml-2 text-muted-foreground">
                        {message}
                      </span>
                    )}
                    {row.eventHash && (
                      <span className="mt-0.5 block break-all font-mono text-[9px] text-muted-foreground/70">
                        {row.eventHash}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {new Date(row.createdAt).toLocaleTimeString()}
                  </span>
                </li>
              );
            })}
          </ol>
        </Card>

        <p className="pb-6 text-center text-[11px] text-muted-foreground">
          Generated {new Date(bundle.generatedAt).toLocaleString()} · AgentGuard
          Control Room
        </p>
      </div>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 break-words">{children}</dd>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("ag-numeric mt-1 text-lg font-semibold", tone)}>
        {value}
      </p>
    </div>
  );
}
