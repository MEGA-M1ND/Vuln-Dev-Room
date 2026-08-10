import * as React from "react";

import type {
  AgentRunStatus,
  PolicyEffect,
  PolicyOutcome,
  RiskLevel,
  RunMode,
} from "@prisma/client";

import { cn } from "@/lib/utils";

/**
 * Shared presentational primitives for the control room.
 *
 * Status colour is decided here and nowhere else. The alternative — each page
 * choosing its own shade for "denied" — is how a red in one table ends up
 * meaning something different from the red in the next one.
 */

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

export const RUN_STATUS_TONE: Record<AgentRunStatus, string> = {
  DRAFT: "border-border text-muted-foreground",
  PREFLIGHT: "border-border text-muted-foreground",
  QUEUED: "border-border text-muted-foreground",
  RUNNING: "border-agent/40 text-agent bg-agent/10",
  PAUSED: "border-gate/40 text-gate bg-gate/10",
  AWAITING_APPROVAL: "border-gate/40 text-gate bg-gate/10",
  WAITING_FOR_INPUT: "border-gate/40 text-gate bg-gate/10",
  BLOCKED: "border-gate/40 text-gate bg-gate/10",
  REVIEW_READY: "border-tool/40 text-tool bg-tool/10",
  SUCCEEDED: "border-allow/40 text-allow bg-allow/10",
  MERGED: "border-allow/40 text-allow bg-allow/10",
  FAILED: "border-deny/40 text-deny bg-deny/10",
  CANCELLED: "border-border text-muted-foreground",
  ABANDONED: "border-border text-muted-foreground",
};

export const RUN_STATUS_LABEL: Record<AgentRunStatus, string> = {
  DRAFT: "Draft",
  PREFLIGHT: "Preflight",
  QUEUED: "Queued",
  RUNNING: "Running",
  PAUSED: "Paused",
  AWAITING_APPROVAL: "Awaiting approval",
  WAITING_FOR_INPUT: "Waiting for input",
  BLOCKED: "Blocked",
  REVIEW_READY: "Review ready",
  SUCCEEDED: "Completed",
  MERGED: "Merged",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  ABANDONED: "Abandoned",
};

export const RUN_MODE_LABEL: Record<RunMode, string> = {
  PLAN_ONLY: "Plan only",
  VERIFY_PULL_REQUEST: "Verify pull request",
  PROPOSE_CODE_CHANGE: "Propose code change",
};

export const OUTCOME_TONE: Record<PolicyOutcome, string> = {
  ALLOWED: "border-allow/40 text-allow bg-allow/10",
  APPROVAL_REQUIRED: "border-gate/40 text-gate bg-gate/10",
  DENIED: "border-deny/40 text-deny bg-deny/10",
};

export const OUTCOME_LABEL: Record<PolicyOutcome, string> = {
  ALLOWED: "Allowed",
  APPROVAL_REQUIRED: "Approval required",
  DENIED: "Denied",
};

export const EFFECT_TONE: Record<PolicyEffect, string> = {
  ALLOW: "border-allow/40 text-allow bg-allow/10",
  REQUIRE_APPROVAL: "border-gate/40 text-gate bg-gate/10",
  DENY: "border-deny/40 text-deny bg-deny/10",
};

export const RISK_TONE: Record<RiskLevel, string> = {
  LOW: "border-allow/40 text-allow bg-allow/10",
  MEDIUM: "border-gate/40 text-gate bg-gate/10",
  HIGH: "border-deny/40 text-deny bg-deny/10",
};

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export function Pill({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: AgentRunStatus }) {
  const live = status === "RUNNING";
  return (
    <Pill className={RUN_STATUS_TONE[status]}>
      {live && (
        <span
          className="relative flex h-1.5 w-1.5"
          // Decorative: the label already says "Running".
          aria-hidden="true"
        >
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-agent opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-agent" />
        </span>
      )}
      {RUN_STATUS_LABEL[status]}
    </Pill>
  );
}

export function RiskPill({ level }: { level: RiskLevel }) {
  return (
    <Pill className={RISK_TONE[level]}>
      {level.charAt(0) + level.slice(1).toLowerCase()} risk
    </Pill>
  );
}

export function OutcomePill({ outcome }: { outcome: PolicyOutcome }) {
  return <Pill className={OUTCOME_TONE[outcome]}>{OUTCOME_LABEL[outcome]}</Pill>;
}

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ag-card", className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-border px-5 py-4",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}

/** A dashboard metric. `value` is intentionally allowed to be null — see below. */
export function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number | string | null;
  hint?: string;
  tone?: "allow" | "gate" | "deny" | "agent";
}) {
  const toneClass =
    tone === "allow"
      ? "text-allow"
      : tone === "gate"
        ? "text-gate"
        : tone === "deny"
          ? "text-deny"
          : tone === "agent"
            ? "text-agent"
            : "text-foreground";

  return (
    <Card className="px-5 py-4">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("ag-numeric mt-2 text-2xl font-semibold", toneClass)}>
        {/* An em dash rather than 0: "no data" and "zero" are different claims,
            and a metric that shows 0% integrity when nothing has been checked
            would be actively misleading. */}
        {value === null ? <span className="text-muted-foreground">—</span> : value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{description}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Monospace code/branch/path fragment. */
export function Mono({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <code
      className={cn(
        "rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/90",
        className,
      )}
    >
      {children}
    </code>
  );
}

/** Fixed-width relative time. Renders on the server as an absolute date. */
export function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
