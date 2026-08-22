import type { ValidationProvenanceValue } from "@/contracts/handoffs";
import { cn } from "@/lib/utils";

/**
 * Says where a test result came from, next to the result itself.
 *
 * Deliberately not a neutral grey chip. A self-reported result is an assertion
 * by the party the review exists to check, and rendering it the same weight as
 * an executed one is how "the agent said tests passed" came to look like
 * evidence. The unverified state is styled as a warning and names the reason
 * in a tooltip, so a reviewer does not have to know the vocabulary to
 * understand they are being told something.
 */

const STYLES: Record<
  ValidationProvenanceValue,
  { label: string; className: string; title: string }
> = {
  EXECUTED_BY_PLATFORM: {
    label: "Executed by the platform",
    className: "border-green-800 bg-green-950/50 text-green-300",
    title:
      "Run in an isolated environment the platform controls, with a recorded command, exit code and bounded output.",
  },
  EXTERNALLY_ATTESTED: {
    label: "Externally attested · unverified",
    className: "border-amber-800 bg-amber-950/50 text-amber-300",
    title:
      "Reported by an external system. Signature verification is not implemented, so this is informational only and cannot satisfy a gate.",
  },
  SELF_REPORTED_BY_AGENT: {
    label: "Self-reported · unverified",
    className: "border-amber-800 bg-amber-950/50 text-amber-300",
    title:
      "The agent asserted this outcome; the platform did not observe it. This is not evidence and cannot satisfy a validation gate.",
  },
};

export function ValidationProvenanceBadge({
  provenance,
  className,
}: {
  provenance: ValidationProvenanceValue | null | undefined;
  className?: string;
}) {
  // Missing provenance is untrusted provenance — the same default the database
  // column carries, so an older record cannot render as though it were verified.
  const style = STYLES[provenance ?? "SELF_REPORTED_BY_AGENT"] ?? STYLES.SELF_REPORTED_BY_AGENT;

  return (
    <span
      title={style.title}
      className={cn(
        "mt-1 inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium",
        style.className,
        className,
      )}
    >
      {style.label}
    </span>
  );
}
