// @vitest-environment node
import { describe, expect, it } from "vitest";

import { scanAndRedact, scanAndRedactMany } from "@/lib/agent-coordination/redaction";

/**
 * The secret filter on agent-published content.
 *
 * Two behaviours have to hold at once, and they pull in opposite directions:
 * a real leaked credential must be REFUSED outright (storing a redacted copy
 * would hide an incident), while the noisy heuristics must only REDACT
 * (rejecting on them would make the tool unusable for the security work it
 * exists to coordinate). Both halves are pinned here, including the
 * false-positive cases that justify the split.
 */

/**
 * Fixtures are ASSEMBLED AT RUNTIME rather than written as literals.
 *
 * These are synthetic, but they are deliberately credential-SHAPED — that is
 * the whole point of the test — and a literal of that shape in a committed
 * file trips GitHub push protection and every downstream secret scanner. It
 * did: this file was rejected on its first push for the Slack and Stripe
 * entries. Splitting the prefix from the body keeps the string the scanner
 * under test receives byte-identical while leaving nothing scannable in the
 * source.
 */
const join = (...parts: string[]) => parts.join("");

describe("scanAndRedact — high-confidence secrets are refused outright", () => {
  const REJECTED: Array<[string, string]> = [
    [
      "PEM private key",
      join(
        "Found this in the repo:\n-----BEGIN RSA ",
        "PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      ),
    ],
    ["AWS access key id", join("The config had AKIA", "IOSFODNN7EXAMPLE in it.")],
    [
      "GitHub token",
      join("committed token ghp", "_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 in .env"),
    ],
    [
      "Slack token",
      join("xoxb", "-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"),
    ],
    ["Stripe secret key", join("sk", "_live_aBcDeFgHiJkLmNoPqRsTuVwXyZ01")],
    [
      "JWT",
      join(
        "Authorization used eyJ",
        "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0",
        ".dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      ),
    ],
  ];

  for (const [label, content] of REJECTED) {
    it(`refuses to store a ${label}`, () => {
      const result = scanAndRedact(content);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.findings.length).toBeGreaterThan(0);
    });
  }

  it("never echoes the secret back in its findings", () => {
    const secret = join("AKIA", "IOSFODNN7EXAMPLE");
    const result = scanAndRedact(`key is ${secret}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    // An error message that quotes what it refused is itself a leak — the
    // refusal would get logged, returned to the caller, and land in a
    // transcript. Findings carry rule names only.
    const serialized = JSON.stringify(result.findings);
    expect(serialized).not.toContain(secret);
  });
});

describe("scanAndRedact — heuristic matches are redacted, not refused", () => {
  it("redacts an Authorization header value but keeps the discovery", () => {
    const result = scanAndRedact(
      "The endpoint replies 200 when you send Authorization: Bearer abcdef1234567890xyz",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.redacted).toBe(true);
    expect(result.content).toContain("[REDACTED]");
    expect(result.content).not.toContain("abcdef1234567890xyz");
    // The surrounding finding survives — that is the point of redacting
    // rather than refusing.
    expect(result.content).toContain("The endpoint replies 200");
  });

  it("redacts a secret-looking assignment", () => {
    const result = scanAndRedact('config.json contains API_KEY="s3cr3tvalue12345"');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.redacted).toBe(true);
    expect(result.content).not.toContain("s3cr3tvalue12345");
  });

  it("redacts inline credentials in a connection string", () => {
    const result = scanAndRedact(
      "It connects to postgresql://admin:hunter2pass@db.internal:5432/app",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.redacted).toBe(true);
    expect(result.content).not.toContain("hunter2pass");
  });
});

describe("scanAndRedact — ordinary security prose passes through untouched", () => {
  // These are the cases that justify redact-not-reject on the heuristics. If
  // any of them tripped the filter, agents could not report real findings.
  const CLEAN = [
    "The login endpoint does not rate-limit, so credential stuffing is viable.",
    "src/auth/session.ts:42 reads API_KEY from the environment without validating it.",
    "Recommend rotating the token stored in the deploy pipeline.",
    "The header is missing entirely; there is no Authorization check on /admin.",
  ];

  for (const content of CLEAN) {
    it(`leaves untouched: "${content.slice(0, 45)}…"`, () => {
      const result = scanAndRedact(content);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.redacted).toBe(false);
      expect(result.content).toBe(content);
    });
  }
});

describe("scanAndRedactMany", () => {
  it("refuses the whole set when any one field carries a secret", () => {
    // A body that passes while an evidence excerpt still carries a key would
    // defeat the control entirely — they are scanned as one unit.
    const result = scanAndRedactMany([
      "Harmless summary of the finding.",
      join("excerpt with AKIA", "IOSFODNN7EXAMPLE inside"),
    ]);
    expect(result.ok).toBe(false);
  });

  it("reports redaction across the set and preserves null holes", () => {
    const result = scanAndRedactMany([
      "Clean body.",
      null,
      "Authorization: Bearer abcdef1234567890xyz",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.redacted).toBe(true);
    expect(result.values[0]).toBe("Clean body.");
    // Positional alignment matters: evidence excerpts are mapped back by
    // index, so a dropped null would attach the wrong text to the wrong row.
    expect(result.values[1]).toBeNull();
    expect(result.values[2]).toContain("[REDACTED]");
  });

  it("does not carry regex state between calls", () => {
    // Every rule is a /g regex. Reusing one across calls without resetting
    // lastIndex makes detection depend on what was scanned before it — the
    // classic way a filter like this silently starts missing every other hit.
    const content = "Authorization: Bearer abcdef1234567890xyz";
    for (let i = 0; i < 5; i++) {
      const result = scanAndRedact(content);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.redacted, `call ${i + 1} should still redact`).toBe(true);
    }
  });
});
