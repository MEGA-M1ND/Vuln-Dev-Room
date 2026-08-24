import { Mono, Pill, formatDuration } from "@/components/agentguard/primitives";
import type { ValidationReceiptView, ValidationView } from "@/lib/attestation/view";

/**
 * Validation receipts for a run, and whether they satisfy the gate.
 *
 * The layout enforces the distinction the data model exists to make. Executed
 * receipts and claims are in SEPARATE sections under different headings, not
 * one list with a status column — a reader skimming the page cannot
 * accidentally read an agent's assertion as an observation, because the two are
 * not adjacent.
 */

export function ValidationPanel({ view }: { view: ValidationView }) {
  const executed = view.receipts.filter(
    (r) => r.provenance === "EXECUTED_BY_PLATFORM",
  );
  const claims = view.receipts.filter(
    (r) => r.provenance !== "EXECUTED_BY_PLATFORM",
  );

  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <p className="text-sm font-semibold">Validation</p>
        <GateVerdict gate={view.gate} />
      </div>

      {view.receipts.length === 0 ? (
        <div className="px-5 py-4">
          <p className="text-xs text-muted-foreground">
            Nothing has been validated. A gate that requires executed validation
            will refuse delivery for this run.
          </p>
          {/*
            Without this the page reads as a contradiction: the approval card
            above may show "48/48 passing" from a TEST_RESULT artifact while
            this panel says nothing was validated. Both are true, and the
            difference between them is the entire point — so say it here rather
            than leaving a reviewer to reconcile the two.
          */}
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            A test-results <em>artifact</em> elsewhere on this page is not a
            receipt. It records what was reported; a receipt records what the
            platform observed — the command, the environment it ran in, and the
            exit code.
          </p>
        </div>
      ) : (
        <>
          <Section
            title="Executed by the platform"
            note="Run in an environment the platform controls, with a recorded command and exit code. Only these can satisfy a gate."
            count={executed.length}
          >
            {executed.map((r) => (
              <ReceiptRow
                key={r.id}
                receipt={r}
                currentDigest={view.shortCurrentProposalDigest}
              />
            ))}
          </Section>

          {claims.length > 0 && (
            <Section
              title="Claims — not evidence"
              note="Reported to us rather than observed by us. Recorded for context; can never satisfy a gate."
              count={claims.length}
              tone="warn"
            >
              {claims.map((r) => (
                <ReceiptRow
                  key={r.id}
                  receipt={r}
                  currentDigest={view.shortCurrentProposalDigest}
                />
              ))}
            </Section>
          )}
        </>
      )}

      <div className="border-t border-border px-5 py-2.5">
        <p className="text-[11px] text-muted-foreground">
          Current proposal digest <Mono>{view.shortCurrentProposalDigest}</Mono>{" "}
          — a receipt for any other digest tested different bytes and does not
          vouch for this work.
        </p>
      </div>
    </div>
  );
}

function GateVerdict({ gate }: { gate: ValidationView["gate"] }) {
  if (gate.satisfied) {
    return (
      <Pill className="border-allow/40 text-allow">Gate satisfied</Pill>
    );
  }
  return (
    <Pill className="border-deny/40 text-deny">
      Gate not satisfied{gate.reason ? ` · ${gate.reason}` : ""}
    </Pill>
  );
}

function Section({
  title,
  note,
  count,
  tone,
  children,
}: {
  title: string;
  note: string;
  count: number;
  tone?: "warn";
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        "border-t border-border px-5 py-3 " +
        (tone === "warn" ? "bg-gate/[0.04]" : "")
      }
    >
      <p
        className={
          "text-[11px] font-medium uppercase tracking-wider " +
          (tone === "warn" ? "text-gate" : "text-muted-foreground")
        }
      >
        {title} ({count})
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">{note}</p>
      {count === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">None.</p>
      ) : (
        <ul className="mt-2.5 space-y-2.5">{children}</ul>
      )}
    </div>
  );
}

function ReceiptRow({
  receipt,
  currentDigest,
}: {
  receipt: ValidationReceiptView;
  currentDigest: string;
}) {
  return (
    <li className="rounded-md border border-border bg-background px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Mono className="max-w-full truncate">{receipt.command}</Mono>
        <ExitPill receipt={receipt} />
      </div>

      <dl className="mt-2 grid gap-x-5 gap-y-1 text-[11px] sm:grid-cols-2">
        <Field label="Provenance">
          <span className={receipt.trusted ? "text-allow" : "text-gate"}>
            {receipt.label}
          </span>
        </Field>
        <Field label="Environment">
          {receipt.environmentId ? (
            <Mono>{receipt.environmentId}</Mono>
          ) : (
            // Explicit rather than blank: the absence is the point.
            <span className="text-gate">none observed</span>
          )}
        </Field>
        <Field label="Started">
          {new Date(receipt.startedAt).toLocaleString()}
        </Field>
        <Field label="Completed">
          {receipt.completedAt ? (
            <>
              {new Date(receipt.completedAt).toLocaleString()}
              {receipt.durationMs !== null && (
                <span className="text-muted-foreground">
                  {" "}
                  · {formatDuration(receipt.durationMs)}
                </span>
              )}
            </>
          ) : (
            <span className="text-gate">not recorded</span>
          )}
        </Field>
        <Field label="Tested digest">
          {receipt.shortBoundDigest ? (
            <>
              <Mono>{receipt.shortBoundDigest}</Mono>
              {receipt.matchesCurrentProposal === false && (
                <span className="ml-1.5 text-deny">
                  ≠ current ({currentDigest})
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">not recorded</span>
          )}
        </Field>
        {receipt.outputByteCount !== null && receipt.outputByteCount > 0 && (
          <Field label="Output">
            {receipt.outputByteCount.toLocaleString()} bytes captured
          </Field>
        )}
      </dl>

      {receipt.refusal && (
        <p className="mt-2 text-[11px] text-gate">{receipt.refusal}</p>
      )}
    </li>
  );
}

function ExitPill({ receipt }: { receipt: ValidationReceiptView }) {
  if (receipt.exitCode === null) {
    return <Pill className="border-gate/40 text-gate">no exit code</Pill>;
  }
  const ok = receipt.exitCode === 0;
  return (
    <Pill className={ok ? "border-allow/40 text-allow" : "border-deny/40 text-deny"}>
      exit {receipt.exitCode}
    </Pill>
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
    <div className="flex flex-wrap items-baseline gap-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
