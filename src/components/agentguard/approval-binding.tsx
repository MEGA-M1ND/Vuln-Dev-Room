import { Mono, Pill } from "@/components/agentguard/primitives";
import type {
  ApprovalBindingView,
  SupersededView,
} from "@/lib/approvals/view";

/**
 * What a reviewer's decision is actually bound to.
 *
 * The prose summary above this panel is what a reviewer READS. This is what
 * their decision is CHECKED AGAINST before anything executes — the artifact
 * digests, the base commit, the planned actions, the policy set, and the
 * deadline. Showing it is the point: an approval nobody can inspect is
 * indistinguishable from an approval that binds nothing, which is precisely
 * what this used to be.
 *
 * Digests are truncated to 12 hex characters. Long enough to compare by eye
 * against a refusal message, short enough that a reviewer will actually look.
 */

export function ApprovalBindingPanel({
  binding,
  className,
}: {
  binding: ApprovalBindingView;
  className?: string;
}) {
  if (binding.legacyUnbound) {
    return (
      <div
        className={
          "rounded-lg border border-deny/40 bg-deny/[0.06] px-5 py-4 " +
          (className ?? "")
        }
      >
        <p className="text-xs font-semibold text-deny">Not bound to anything</p>
        <p className="mt-1 text-[11px] text-foreground/80">
          This approval was granted before approvals were tied to specific
          artifacts, so there is nothing to verify it against. It cannot be used
          to execute. Request a new approval.
        </p>
      </div>
    );
  }

  return (
    <div className={"rounded-lg border border-border bg-muted/20 " + (className ?? "")}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Bound to
        </p>
        <div className="flex items-center gap-2">
          <Mono>{binding.shortDigest}</Mono>
          <ExpiryPill expiresInMs={binding.expiresInMs} />
        </div>
      </div>

      <dl className="grid gap-x-6 gap-y-2 px-5 py-3 text-xs sm:grid-cols-2">
        {binding.baseState && (
          <>
            <Field label="Base commit">
              {binding.baseState.shortRevision ? (
                <Mono>{binding.baseState.shortRevision}</Mono>
              ) : (
                <span className="text-muted-foreground">
                  none recorded
                </span>
              )}
            </Field>
            <Field label="Base branch">
              <Mono>{binding.baseState.baseBranch}</Mono>
            </Field>
          </>
        )}
        {binding.policyShortDigest && (
          <Field label="Policy set">
            <Mono>{binding.policyShortDigest}</Mono>
          </Field>
        )}
        {binding.expiresAt && (
          <Field label="Expires">
            {new Date(binding.expiresAt).toLocaleString()}
          </Field>
        )}
      </dl>

      {binding.plannedActions.length > 0 && (
        <div className="border-t border-border px-5 py-3">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Planned actions
          </p>
          <ul className="space-y-1 text-xs">
            {binding.plannedActions.map((a, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-2">
                <Pill className="border-border text-foreground/80">{a.action}</Pill>
                {a.command && <Mono>{a.command}</Mono>}
                {a.branch && <Mono>{a.branch}</Mono>}
                {a.path && <Mono>{a.path}</Mono>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {binding.artifacts.length > 0 && (
        <div className="border-t border-border px-5 py-3">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Artifacts ({binding.artifacts.length})
          </p>
          <ul className="space-y-1 text-xs">
            {binding.artifacts.map((a) => (
              <li
                key={a.sequence}
                className="flex flex-wrap items-baseline justify-between gap-2"
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <Pill className="border-border text-muted-foreground">
                    {a.type}
                  </Pill>
                  <span className="truncate text-foreground/85">{a.title}</span>
                </span>
                <Mono>{a.shortDigest}</Mono>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Editing any of these — or adding, removing or relabelling one —
            invalidates this approval.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The red block that replaces the Approve/Reject buttons once a binding drifts.
 *
 * This is the single most important thing on the page. Before it existed, an
 * approval whose diff had changed looked exactly like one whose diff had not,
 * and the only way to find out was to press Approve and get a 409.
 */
export function SupersededBanner({
  superseded,
  className,
}: {
  superseded: SupersededView;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={
        "rounded-lg border border-deny/50 bg-deny/[0.08] px-5 py-4 " +
        (className ?? "")
      }
    >
      <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-deny">
        {superseded.reason === "EXPIRED"
          ? "Expired — this approval can no longer be used"
          : "Superseded — the work changed after it was approved"}
        <Mono className="bg-deny/15 text-deny">{superseded.reason}</Mono>
      </p>
      <p className="mt-1.5 text-[11px] text-foreground/85">{superseded.message}</p>
      {superseded.detail && (
        <p className="mt-1 text-[11px] text-muted-foreground">{superseded.detail}</p>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        {superseded.detectedLive
          ? "Detected just now while loading this page — nothing has executed."
          : superseded.invalidatedAt
            ? `Recorded ${new Date(superseded.invalidatedAt).toLocaleString()}.`
            : "Recorded on the approval."}{" "}
        A new approval must be requested against the current work.
      </p>
    </div>
  );
}

/** Time left, coloured by urgency. Renders "Expired" once past. */
function ExpiryPill({ expiresInMs }: { expiresInMs: number | null }) {
  if (expiresInMs === null) {
    return <Pill className="border-border text-muted-foreground">No expiry</Pill>;
  }
  if (expiresInMs <= 0) {
    return <Pill className="border-deny/40 text-deny">Expired</Pill>;
  }

  const minutes = Math.floor(expiresInMs / 60_000);
  const label =
    minutes >= 60
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left`
      : `${Math.max(minutes, 1)}m left`;

  // Under fifteen minutes is worth noticing before starting a careful review.
  const tone =
    minutes < 15 ? "border-gate/40 text-gate" : "border-border text-muted-foreground";
  return <Pill className={tone}>{label}</Pill>;
}

function Field({
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
