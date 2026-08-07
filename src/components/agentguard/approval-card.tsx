"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Mono, Pill, RiskPill } from "@/components/agentguard/primitives";
import { Button } from "@/components/ui/button";

/**
 * The review card a reviewer acts on.
 *
 * Shows everything needed to judge the change without leaving the page: what is
 * being requested, which rule forced the gate, the files touched, the test
 * outcome, and the risk. A reviewer who has to go hunting for context will
 * eventually stop looking and just approve.
 */

export type ApprovalDetails = {
  reason?: string;
  repository?: string;
  baseBranch?: string;
  workingBranch?: string | null;
  agent?: string;
  task?: string;
  objective?: string | null;
  filesChanged?: string[];
  diffStat?: { filesChanged: number; additions: number; deletions: number } | null;
  testResults?: { total?: number; passed?: number; failed?: number } | null;
  riskLevel?: "LOW" | "MEDIUM" | "HIGH";
};

export function ApprovalCard({
  approvalId,
  action,
  summary,
  details,
  requestedBy,
  requestedAt,
  canDecide,
  /** Why the viewer cannot decide, when they cannot. */
  blockedReason,
  compact = false,
}: {
  approvalId: string;
  action: string;
  summary: string;
  details: ApprovalDetails;
  requestedBy: string | null;
  requestedAt: string;
  canDecide: boolean;
  blockedReason?: string | null;
  compact?: boolean;
}) {
  const router = useRouter();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    setError(null);
    try {
      const response = await fetch(
        `/api/approval-requests/${approvalId}/${decision}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comment: comment.trim() || null }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          body?.error?.message ?? `Could not ${decision} this request.`,
        );
      }
      setComment("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something failed.");
    } finally {
      setBusy(null);
    }
  }

  const tests = details.testResults;
  const stat = details.diffStat;

  return (
    <div className="rounded-lg border border-gate/40 bg-gate/[0.04]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gate/20 px-5 py-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-gate">
            Approval required
          </p>
          <p className="mt-1 text-xs text-foreground/85">{summary}</p>
          {details.reason && details.reason !== summary && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {details.reason}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {details.riskLevel && <RiskPill level={details.riskLevel} />}
          <Pill className="border-gate/40 text-gate">{action}</Pill>
        </div>
      </div>

      <dl className="grid gap-x-6 gap-y-2 px-5 py-4 text-xs sm:grid-cols-2">
        {details.repository && (
          <Row label="Repository">
            <Mono>{details.repository}</Mono>
          </Row>
        )}
        {details.workingBranch && (
          <Row label="Branch">
            <Mono>{details.workingBranch}</Mono>
            <span className="text-muted-foreground"> → </span>
            <Mono>{details.baseBranch ?? "main"}</Mono>
          </Row>
        )}
        {details.agent && <Row label="Agent">{details.agent}</Row>}
        <Row label="Requested by">
          {requestedBy ?? "—"}
          <span className="text-muted-foreground">
            {" "}
            · {new Date(requestedAt).toLocaleString()}
          </span>
        </Row>
        {stat && (
          <Row label="Changes">
            <span className="ag-numeric">
              {stat.filesChanged} file{stat.filesChanged === 1 ? "" : "s"}
              <span className="ml-2 text-allow">+{stat.additions}</span>
              <span className="ml-1 text-deny">−{stat.deletions}</span>
            </span>
          </Row>
        )}
        {tests && (
          <Row label="Tests">
            <span
              className={
                (tests.failed ?? 0) > 0 ? "text-deny" : "text-allow"
              }
            >
              {tests.passed ?? 0}/{tests.total ?? 0} passing
            </span>
          </Row>
        )}
      </dl>

      {!compact && details.filesChanged && details.filesChanged.length > 0 && (
        <div className="border-t border-gate/20 px-5 py-3">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Files changed
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {details.filesChanged.map((file) => (
              <li key={file}>
                <Mono>{file}</Mono>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border-t border-gate/20 px-5 py-4">
        {canDecide ? (
          <>
            <label
              htmlFor={`comment-${approvalId}`}
              className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              Comment (optional)
            </label>
            <textarea
              id={`comment-${approvalId}`}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              rows={2}
              placeholder="Recorded in the audit trail alongside your decision."
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-xs placeholder:text-muted-foreground/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              maxLength={2000}
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button disabled={busy !== null} onClick={() => decide("approve")}>
                {busy === "approve" ? "Approving…" : "Approve"}
              </Button>
              <Button
                variant="secondary"
                disabled={busy !== null}
                onClick={() => decide("reject")}
              >
                {busy === "reject" ? "Rejecting…" : "Reject"}
              </Button>
              {error && (
                <span role="alert" className="text-[11px] text-deny">
                  {error}
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {blockedReason ??
              "You do not have permission to resolve this request."}
          </p>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
