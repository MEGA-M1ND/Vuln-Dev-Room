"use client";

import { useState } from "react";

import {
  Card,
  CardHeader,
  OutcomePill,
  Pill,
} from "@/components/agentguard/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Policy simulator.
 *
 * Posts to `/api/policies/evaluate`, which calls the same `evaluateAction` the
 * executor uses. Nothing is reimplemented here and nothing is persisted — a
 * simulator that drifts from the engine is worse than no simulator, because
 * someone will trust it.
 */

const ACTIONS = [
  "READ_FILE",
  "WRITE_FILE",
  "RUN_TESTS",
  "RUN_COMMAND",
  "INSPECT_DIFF",
  "CREATE_BRANCH",
  "CREATE_PULL_REQUEST",
  "PUSH_PROTECTED_BRANCH",
  "READ_SECRET",
  "DEPLOY_PRODUCTION",
] as const;

const MODES = ["PLAN_ONLY", "VERIFY_PULL_REQUEST", "PROPOSE_CODE_CHANGE"] as const;

type Evaluation = {
  outcome: "ALLOWED" | "APPROVAL_REQUIRED" | "DENIED";
  reason: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  decidedBy: { policyName: string; effect: string } | null;
  matches: { policyId: string; policyName: string; effect: string }[];
};

export function PolicySimulator({
  roomId,
  repositories,
}: {
  roomId: string;
  repositories: string[];
}) {
  const [action, setAction] = useState<string>("WRITE_FILE");
  const [mode, setMode] = useState<string>("PROPOSE_CODE_CHANGE");
  const [repository, setRepository] = useState(repositories[0] ?? "");
  const [branch, setBranch] = useState("main");
  const [path, setPath] = useState("src/auth/session.ts");
  const [command, setCommand] = useState("");

  const [result, setResult] = useState<Evaluation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function evaluate() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/policies/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          action,
          mode,
          repository: repository || null,
          branch: branch || null,
          path: path || null,
          command: command || null,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Could not evaluate.");
      }
      setResult(body.evaluation);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : "Could not evaluate.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Policy simulator"
        description="Ask the live rule set what would happen. Nothing is recorded."
      />

      <div className="grid gap-3 px-5 py-4 sm:grid-cols-2">
        <Labelled label="Action" htmlFor="sim-action">
          <select
            id="sim-action"
            value={action}
            onChange={(event) => setAction(event.target.value)}
            className={inputClass}
          >
            {ACTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Labelled>

        <Labelled label="Run mode" htmlFor="sim-mode">
          <select
            id="sim-mode"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            className={inputClass}
          >
            {MODES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Labelled>

        <Labelled label="Repository" htmlFor="sim-repo">
          <select
            id="sim-repo"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            className={inputClass}
          >
            {repositories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Labelled>

        <Labelled label="Branch" htmlFor="sim-branch">
          <input
            id="sim-branch"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="main"
            className={inputClass}
          />
        </Labelled>

        <Labelled label="File path" htmlFor="sim-path">
          <input
            id="sim-path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder=".env.production"
            className={inputClass}
          />
        </Labelled>

        <Labelled label="Shell command" htmlFor="sim-command">
          <input
            id="sim-command"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="rm -rf build"
            className={inputClass}
          />
        </Labelled>
      </div>

      <div className="flex items-center gap-3 px-5 pb-4">
        <Button disabled={busy} onClick={evaluate}>
          {busy ? "Evaluating…" : "Evaluate"}
        </Button>
        {error && (
          <span role="alert" className="text-[11px] text-deny">
            {error}
          </span>
        )}
      </div>

      {result && (
        <div
          className={cn(
            "border-t px-5 py-4",
            result.outcome === "DENIED"
              ? "border-deny/30 bg-deny/[0.05]"
              : result.outcome === "APPROVAL_REQUIRED"
                ? "border-gate/30 bg-gate/[0.05]"
                : "border-allow/30 bg-allow/[0.05]",
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            <OutcomePill outcome={result.outcome} />
            <span className="text-[11px] text-muted-foreground">
              risk: {result.riskLevel.toLowerCase()}
            </span>
          </div>

          <p className="mt-2 text-xs text-foreground/85">{result.reason}</p>

          <p className="mt-2 text-[11px] text-muted-foreground">
            {result.decidedBy
              ? `Decided by: ${result.decidedBy.policyName}`
              : "No rule matched; the default posture applied."}
          </p>

          {result.matches.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                All matching rules
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {result.matches.map((match) => (
                  <li key={match.policyId}>
                    <Pill
                      className={
                        match.effect === "DENY"
                          ? "border-deny/40 text-deny"
                          : match.effect === "REQUIRE_APPROVAL"
                            ? "border-gate/40 text-gate"
                            : "border-allow/40 text-allow"
                      }
                    >
                      {match.policyName}
                    </Pill>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Labelled({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
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
    </div>
  );
}
