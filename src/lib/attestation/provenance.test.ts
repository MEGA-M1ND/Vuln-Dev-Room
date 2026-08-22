// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  describeProvenance,
  isTrustworthyProvenance,
  satisfiesValidationGate,
  type ValidationReceiptLike,
} from "@/lib/attestation/provenance";

/**
 * What counts as validation.
 *
 * The rule these pin: an agent's word never satisfies a gate, however
 * emphatically it is expressed. Everything else here exists to stop that rule
 * being eroded by a plausible-looking special case.
 */

const DIGEST = "a".repeat(64);

function executed(over: Partial<ValidationReceiptLike> = {}): ValidationReceiptLike {
  return {
    provenance: "EXECUTED_BY_PLATFORM",
    command: "npm test",
    environmentId: "sandbox-4f21a",
    startedAt: new Date("2026-08-22T12:00:00Z"),
    completedAt: new Date("2026-08-22T12:01:30Z"),
    exitCode: 0,
    boundArtifactDigest: DIGEST,
    ...over,
  };
}

describe("self-reported claims never satisfy a gate", () => {
  it("refuses a self-report even when it claims success", () => {
    const result = satisfiesValidationGate(
      executed({
        provenance: "SELF_REPORTED_BY_AGENT",
        exitCode: 0,
        environmentId: null,
        completedAt: null,
      }),
    );
    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.reason).toBe("SELF_REPORTED");
  });

  it("refuses a self-report that carries a zero exit code and an environment", () => {
    // The most dangerous shape: an adapter that fills in every field
    // convincingly. Provenance is checked FIRST, before any of the fields that
    // would make it look like a real execution, precisely so a well-formed
    // forgery gains nothing.
    const result = satisfiesValidationGate(
      executed({ provenance: "SELF_REPORTED_BY_AGENT" }),
    );
    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.reason).toBe("SELF_REPORTED");
  });

  it("refuses when there is no receipt at all", () => {
    const result = satisfiesValidationGate(null);
    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.reason).toBe("NO_RECEIPT");
  });

  it("treats undefined the same as absent", () => {
    // Missing provenance defaults to untrusted, never to executed.
    const result = satisfiesValidationGate(undefined);
    expect(result.satisfied).toBe(false);
  });
});

describe("external attestations are informational only", () => {
  it("refuses a forged-looking attestation", () => {
    const result = satisfiesValidationGate(
      executed({ provenance: "EXTERNALLY_ATTESTED" }),
    );
    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.reason).toBe("EXTERNAL_ATTESTATION_UNVERIFIED");
    // The refusal explains WHY it cannot be trusted, so an operator does not
    // conclude the external system is broken.
    expect(result.detail).toMatch(/verification (is|are) not implemented/i);
  });

  it("is not marked trustworthy", () => {
    expect(isTrustworthyProvenance("EXTERNALLY_ATTESTED")).toBe(false);
    expect(isTrustworthyProvenance("SELF_REPORTED_BY_AGENT")).toBe(false);
    expect(isTrustworthyProvenance("EXECUTED_BY_PLATFORM")).toBe(true);
  });
});

describe("platform execution satisfies a gate only when complete", () => {
  it("accepts a complete, passing receipt", () => {
    expect(satisfiesValidationGate(executed(), DIGEST)).toEqual({ satisfied: true });
  });

  it("refuses a nonzero exit", () => {
    const result = satisfiesValidationGate(executed({ exitCode: 1 }), DIGEST);
    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.reason).toBe("NONZERO_EXIT");
  });

  it("refuses a missing exit code", () => {
    const result = satisfiesValidationGate(executed({ exitCode: null }), DIGEST);
    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.reason).toBe("MISSING_EXIT_CODE");
  });

  it("refuses an execution that has not completed", () => {
    const result = satisfiesValidationGate(executed({ completedAt: null }), DIGEST);
    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.reason).toBe("INCOMPLETE_EXECUTION");
  });

  it("refuses a receipt with no environment identity", () => {
    // An execution nobody can locate is not one we observed.
    const result = satisfiesValidationGate(executed({ environmentId: null }), DIGEST);
    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.reason).toBe("MISSING_ENVIRONMENT");
  });
});

describe("a receipt cannot validate artifacts it did not test", () => {
  it("refuses a genuine passing receipt bound to a different artifact set", () => {
    // The likeliest real-world defeat: the receipt is real and green, it is
    // simply about different bytes. Replaying it against a modified patch must
    // fail.
    const result = satisfiesValidationGate(executed(), "b".repeat(64));
    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.reason).toBe("DIGEST_MISMATCH");
  });

  it("refuses a receipt that records no artifact digest when one is expected", () => {
    const result = satisfiesValidationGate(
      executed({ boundArtifactDigest: null }),
      DIGEST,
    );
    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.reason).toBe("MISSING_BOUND_DIGEST");
  });

  it("does not require a digest when the caller does not supply one", () => {
    // A caller with no particular artifact set in mind still gets a useful
    // answer about whether anything passed.
    expect(satisfiesValidationGate(executed({ boundArtifactDigest: null }))).toEqual({
      satisfied: true,
    });
  });
});

describe("human-facing descriptions", () => {
  it("marks only platform execution as trusted", () => {
    expect(describeProvenance("EXECUTED_BY_PLATFORM").trusted).toBe(true);
    expect(describeProvenance("SELF_REPORTED_BY_AGENT").trusted).toBe(false);
    expect(describeProvenance("EXTERNALLY_ATTESTED").trusted).toBe(false);
  });

  it("labels self-reported results as unverified rather than neutral", () => {
    // The label is the control a reviewer actually sees; "test results" would
    // be accurate and useless.
    expect(describeProvenance("SELF_REPORTED_BY_AGENT").label).toMatch(/unverified/i);
    expect(describeProvenance("EXTERNALLY_ATTESTED").label).toMatch(/unverified/i);
  });
});
