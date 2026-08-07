"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  Card,
  CardHeader,
  Mono,
  RiskPill,
} from "@/components/agentguard/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * New Run form with a live preflight panel.
 *
 * The preflight is fetched from the server on every change to mode, profile, or
 * branch rather than derived client-side from a copy of the rules. A client
 * that reimplements the policy engine will eventually disagree with it, and the
 * disagreement would surface as a promise the run then breaks.
 */

type Repository = {
  id: string;
  fullName: string;
  defaultBranch: string;
};

type Profile = {
  id: string;
  key: string;
  name: string;
  description: string;
  isDefault: boolean;
};

type PreflightEntry = {
  action: string;
  label: string;
  outcome: "ALLOWED" | "APPROVAL_REQUIRED" | "DENIED";
  reason: string;
  policy: string | null;
};

type Preflight = {
  repository: string;
  baseBranch: string;
  mode: string;
  allowed: PreflightEntry[];
  requiresApproval: PreflightEntry[];
  denied: PreflightEntry[];
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  approvalExpected: boolean;
};

const MODES = [
  {
    value: "PLAN_ONLY",
    label: "Plan only",
    hint: "Read and reason. Produces a plan; touches nothing.",
  },
  {
    value: "VERIFY_PULL_REQUEST",
    label: "Verify pull request",
    hint: "Check out an existing PR and run its verification suite.",
  },
  {
    value: "PROPOSE_CODE_CHANGE",
    label: "Propose code change",
    hint: "Produce a diff, gated by approval before any PR is created.",
  },
] as const;

export function NewRunForm({
  roomId,
  repositories,
  profiles,
}: {
  roomId: string;
  repositories: Repository[];
  profiles: Profile[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [repositoryKey, setRepositoryKey] = useState(
    repositories[0]?.fullName ?? "",
  );
  const [baseBranch, setBaseBranch] = useState(
    repositories[0]?.defaultBranch ?? "main",
  );
  const [title, setTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [mode, setMode] = useState<string>("PROPOSE_CODE_CHANGE");
  const [policyProfileId, setPolicyProfileId] = useState(
    profiles.find((p) => p.isDefault)?.id ?? profiles[0]?.id ?? "",
  );
  const [linkedIssueUrl, setLinkedIssueUrl] = useState("");

  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [loadingPreflight, setLoadingPreflight] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const loadPreflight = useCallback(async () => {
    if (!repositoryKey) return;
    setLoadingPreflight(true);
    setPreflightError(null);
    try {
      const response = await fetch("/api/runs/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          repositoryKey,
          baseBranch,
          mode,
          policyProfileId: policyProfileId || null,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Could not evaluate policies.");
      }
      setPreflight(body.preflight);
    } catch (error) {
      setPreflight(null);
      setPreflightError(
        error instanceof Error ? error.message : "Could not evaluate policies.",
      );
    } finally {
      setLoadingPreflight(false);
    }
  }, [roomId, repositoryKey, baseBranch, mode, policyProfileId]);

  useEffect(() => {
    void loadPreflight();
  }, [loadPreflight]);

  const canSubmit = title.trim().length > 0 && repositoryKey && !pending;

  async function submit(startImmediately: boolean) {
    setSubmitError(null);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          repositoryKey,
          baseBranch,
          title: title.trim(),
          taskDescription: taskDescription.trim(),
          mode,
          policyProfileId: policyProfileId || null,
          linkedIssueUrl: linkedIssueUrl.trim() || null,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Could not create the run.");
      }

      const runId: string = body.run.id;

      if (startImmediately) {
        // A failure to start is not a failure to create: the run exists and
        // the control room can start it, so navigate either way rather than
        // stranding the user on a form whose submission actually succeeded.
        await fetch(`/api/runs/${runId}/simulate`, { method: "POST" }).catch(
          () => undefined,
        );
      }

      startTransition(() => {
        router.push(`/runs/${runId}`);
        router.refresh();
      });
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Could not create the run.",
      );
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      {/* Form ------------------------------------------------------------ */}
      <div className="space-y-4">
        <Card>
          <CardHeader title="What should the agent do?" />
          <div className="space-y-4 px-5 py-4">
            <Field label="Task title" htmlFor="title">
              <input
                id="title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Sessions expire an hour early"
                className={inputClass}
                maxLength={200}
              />
            </Field>

            <Field
              label="Detailed description"
              htmlFor="description"
              hint="What the agent is told. Reviewers see this alongside the diff."
            >
              <textarea
                id="description"
                value={taskDescription}
                onChange={(event) => setTaskDescription(event.target.value)}
                rows={5}
                placeholder="Fix the premature session expiry in src/auth/session.ts and cover the full TTL window with a regression test."
                className={cn(inputClass, "resize-y")}
              />
            </Field>

            <Field
              label="Linked GitHub issue"
              htmlFor="issue"
              hint="Optional. A full URL."
            >
              <input
                id="issue"
                value={linkedIssueUrl}
                onChange={(event) => setLinkedIssueUrl(event.target.value)}
                placeholder="https://github.com/astra-engineering/payments-api/issues/128"
                className={inputClass}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Where" />
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
            <Field label="Repository" htmlFor="repository">
              <select
                id="repository"
                value={repositoryKey}
                onChange={(event) => {
                  setRepositoryKey(event.target.value);
                  const match = repositories.find(
                    (r) => r.fullName === event.target.value,
                  );
                  if (match) setBaseBranch(match.defaultBranch);
                }}
                className={inputClass}
              >
                {repositories.map((repository) => (
                  <option key={repository.id} value={repository.fullName}>
                    {repository.fullName}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Base branch" htmlFor="branch">
              <input
                id="branch"
                value={baseBranch}
                onChange={(event) => setBaseBranch(event.target.value)}
                className={inputClass}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="How"
            description="Mode bounds what the agent may attempt. It cannot be widened once the run starts."
          />
          <div className="space-y-2 px-5 py-4">
            {MODES.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
                  mode === option.value
                    ? "border-agent/50 bg-agent/5"
                    : "border-border hover:bg-muted/40",
                )}
              >
                <input
                  type="radio"
                  name="mode"
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => setMode(option.value)}
                  className="mt-0.5 accent-current"
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {option.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <div className="border-t border-border px-5 py-4">
            <Field
              label="Policy profile"
              htmlFor="profile"
              hint="Profiles add restrictions. Global safety rules always apply on top."
            >
              <select
                id="profile"
                value={policyProfileId}
                onChange={(event) => setPolicyProfileId(event.target.value)}
                className={inputClass}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                    {profile.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {profiles.find((p) => p.id === policyProfileId)?.description}
            </p>
          </div>
        </Card>

        {submitError && (
          <p
            role="alert"
            className="rounded-md border border-deny/40 bg-deny/10 px-4 py-3 text-xs text-deny"
          >
            {submitError}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!canSubmit} onClick={() => submit(true)}>
            {pending ? "Creating…" : "Create and start run"}
          </Button>
          <Button
            variant="secondary"
            disabled={!canSubmit}
            onClick={() => submit(false)}
          >
            Create without starting
          </Button>
        </div>
      </div>

      {/* Preflight ------------------------------------------------------- */}
      <div className="lg:sticky lg:top-6 lg:self-start">
        <Card>
          <CardHeader
            title="Preflight"
            description="Evaluated against the live rule set."
            actions={
              loadingPreflight ? (
                <span className="text-[11px] text-muted-foreground">
                  Checking…
                </span>
              ) : preflight ? (
                <RiskPill level={preflight.riskLevel} />
              ) : null
            }
          />

          {preflightError ? (
            <p className="px-5 py-4 text-xs text-deny">{preflightError}</p>
          ) : !preflight ? (
            <p className="px-5 py-8 text-center text-xs text-muted-foreground">
              Evaluating policies…
            </p>
          ) : (
            <div className="space-y-4 px-5 py-4 text-xs">
              <dl className="space-y-1.5">
                <Row label="Repository">
                  <Mono>{preflight.repository}</Mono>
                </Row>
                <Row label="Base branch">
                  <Mono>{preflight.baseBranch}</Mono>
                </Row>
                <Row label="Approval">
                  {preflight.approvalExpected ? (
                    <span className="text-gate">Required before delivery</span>
                  ) : (
                    <span className="text-muted-foreground">
                      Not required for this mode
                    </span>
                  )}
                </Row>
              </dl>

              <PreflightGroup
                title="Allowed"
                tone="text-allow"
                dot="bg-allow"
                entries={preflight.allowed}
              />
              <PreflightGroup
                title="Requires approval"
                tone="text-gate"
                dot="bg-gate"
                entries={preflight.requiresApproval}
              />
              <PreflightGroup
                title="Denied"
                tone="text-deny"
                dot="bg-deny"
                entries={preflight.denied}
                showReason
              />
            </div>
          )}
        </Card>

        <p className="mt-3 px-1 text-[11px] leading-relaxed text-muted-foreground">
          AgentGuard proposes changes and never merges them. There is no code
          path in this product that can land a commit on a protected branch.
        </p>
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
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
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

function PreflightGroup({
  title,
  tone,
  dot,
  entries,
  showReason = false,
}: {
  title: string;
  tone: string;
  dot: string;
  entries: PreflightEntry[];
  showReason?: boolean;
}) {
  if (entries.length === 0) return null;

  return (
    <div>
      <p
        className={cn(
          "mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider",
          tone,
        )}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", dot)} aria-hidden="true" />
        {title}
        <span className="ag-numeric font-normal text-muted-foreground">
          {entries.length}
        </span>
      </p>
      <ul className="space-y-1">
        {entries.map((entry) => (
          <li key={entry.action} className="leading-snug">
            <span className="text-foreground/90">{entry.label}</span>
            {showReason && (
              <span className="block text-[11px] text-muted-foreground">
                {entry.reason}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
