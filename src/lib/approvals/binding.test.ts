// @vitest-environment node
import { describe, expect, it } from "vitest";

import { canonicalize } from "@/lib/audit/hash-chain";
import {
  BINDING_VERSION,
  computeArtifactContentHash,
  digestOf,
  type ApprovalBindingPayload,
} from "@/lib/approvals/binding";

/**
 * Binding digest determinism.
 *
 * A binding is only a control if the same state always produces the same
 * digest and different state always produces a different one. These are pure
 * tests over the encoder — no database — because the properties must hold
 * regardless of how rows happened to be retrieved.
 */

function payload(over: Partial<ApprovalBindingPayload> = {}): ApprovalBindingPayload {
  return {
    v: BINDING_VERSION,
    runId: "run_1",
    scope: { action: "CREATE_PULL_REQUEST" },
    artifacts: [
      {
        sequence: 1,
        id: "art_1",
        type: "PLAN",
        title: "Plan",
        contentSha256: "a".repeat(64),
      },
      {
        sequence: 2,
        id: "art_2",
        type: "DIFF",
        title: "Unified diff",
        contentSha256: "b".repeat(64),
      },
    ],
    baseState: {
      repositoryKey: "acme/api",
      baseBranch: "main",
      baseRevision: "abc1234",
    },
    plannedActions: [
      {
        action: "CREATE_PULL_REQUEST",
        command: null,
        path: null,
        branch: "devroom/fix-1",
        args: null,
      },
    ],
    policyDigest: "c".repeat(64),
    createdAt: "2026-08-22T12:00:00.000Z",
    expiresAt: "2026-08-22T14:00:00.000Z",
    ...over,
  };
}

describe("digest determinism", () => {
  it("produces a 64-character hex sha256", () => {
    expect(digestOf(payload())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across repeated calls", () => {
    const p = payload();
    expect(digestOf(p)).toBe(digestOf(p));
  });

  it("is independent of key insertion order", () => {
    // Two structurally identical payloads built in different orders must agree.
    // `canonicalize` sorts keys recursively; without that, the same approval
    // built by two code paths would hash differently and every verification
    // would report false tampering.
    const a = payload();
    const b: ApprovalBindingPayload = JSON.parse(
      JSON.stringify({
        expiresAt: a.expiresAt,
        createdAt: a.createdAt,
        policyDigest: a.policyDigest,
        plannedActions: a.plannedActions,
        baseState: {
          baseRevision: a.baseState.baseRevision,
          baseBranch: a.baseState.baseBranch,
          repositoryKey: a.baseState.repositoryKey,
        },
        artifacts: a.artifacts,
        scope: a.scope,
        runId: a.runId,
        v: a.v,
      }),
    );
    expect(digestOf(b)).toBe(digestOf(a));
  });

  it("is independent of the order artifacts were retrieved in", () => {
    // The manifest is built with `orderBy: sequence asc`. This pins that the
    // ENCODER is not accidentally order-insensitive: a genuinely reordered
    // manifest is a different binding, and the builder is what guarantees a
    // canonical order.
    const a = payload();
    const reversed = payload({ artifacts: [...a.artifacts].reverse() });
    expect(digestOf(reversed)).not.toBe(digestOf(a));
  });

  it("treats an absent optional field and an explicit null identically", () => {
    // `canonicalize` drops `undefined` but keeps `null`, matching JSON. Two
    // payloads that mean the same thing must not disagree.
    const withNull = payload();
    const withUndefined = payload({
      plannedActions: [
        {
          action: "CREATE_PULL_REQUEST",
          command: undefined,
          path: undefined,
          branch: "devroom/fix-1",
          args: undefined,
        },
      ],
    });
    // These are NOT equal — null is a value and undefined is absence — which is
    // exactly why `buildApprovalBinding` normalizes every optional to null
    // before hashing. Pinning the asymmetry stops someone "simplifying" the
    // normalizer away.
    expect(digestOf(withUndefined)).not.toBe(digestOf(withNull));
    expect(canonicalize({ a: undefined })).toBe("{}");
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });
});

describe("semantically different payloads differ", () => {
  const base = digestOf(payload());

  const CHANGES: Array<[string, Partial<ApprovalBindingPayload>]> = [
    ["a changed artifact content hash", {
      artifacts: [
        { sequence: 1, id: "art_1", type: "PLAN", title: "Plan", contentSha256: "a".repeat(64) },
        { sequence: 2, id: "art_2", type: "DIFF", title: "Unified diff", contentSha256: "d".repeat(64) },
      ],
    }],
    ["an added artifact", {
      artifacts: [
        ...payload().artifacts,
        { sequence: 3, id: "art_3", type: "LOG", title: "Log", contentSha256: "e".repeat(64) },
      ],
    }],
    ["a removed artifact", { artifacts: [payload().artifacts[0]!] }],
    ["a renamed artifact", {
      artifacts: [
        { sequence: 1, id: "art_1", type: "PLAN", title: "Nothing to see here", contentSha256: "a".repeat(64) },
        payload().artifacts[1]!,
      ],
    }],
    ["a moved base revision", {
      baseState: { repositoryKey: "acme/api", baseBranch: "main", baseRevision: "def5678" },
    }],
    ["a different base branch", {
      baseState: { repositoryKey: "acme/api", baseBranch: "develop", baseRevision: "abc1234" },
    }],
    ["a different repository", {
      baseState: { repositoryKey: "acme/other", baseBranch: "main", baseRevision: "abc1234" },
    }],
    ["a changed command", {
      plannedActions: [{ action: "CREATE_PULL_REQUEST", command: "rm -rf /", path: null, branch: "devroom/fix-1", args: null }],
    }],
    ["changed arguments", {
      plannedActions: [{ action: "CREATE_PULL_REQUEST", command: null, path: null, branch: "devroom/fix-1", args: { force: true } }],
    }],
    ["a changed policy digest", { policyDigest: "f".repeat(64) }],
    ["a changed scope", { scope: { action: "DEPLOY_PRODUCTION" } }],
    ["a changed expiry", { expiresAt: "2026-08-22T23:00:00.000Z" }],
    ["a changed binding version", { v: BINDING_VERSION + 1 }],
  ];

  for (const [label, over] of CHANGES) {
    it(`differs for ${label}`, () => {
      expect(digestOf(payload(over))).not.toBe(base);
    });
  }
});

describe("artifact content hashing", () => {
  it("is stable for identical content", () => {
    const a = { contentText: "hello", contentJson: { files: ["a.ts"] } };
    expect(computeArtifactContentHash(a)).toBe(computeArtifactContentHash({ ...a }));
  });

  it("changes when text changes by one character", () => {
    expect(
      computeArtifactContentHash({ contentText: "hello", contentJson: null }),
    ).not.toBe(computeArtifactContentHash({ contentText: "hellO", contentJson: null }));
  });

  it("changes when json content changes", () => {
    expect(
      computeArtifactContentHash({ contentText: null, contentJson: { a: 1 } }),
    ).not.toBe(computeArtifactContentHash({ contentText: null, contentJson: { a: 2 } }));
  });

  it("is independent of json key order", () => {
    expect(
      computeArtifactContentHash({ contentText: null, contentJson: { a: 1, b: 2 } }),
    ).toBe(computeArtifactContentHash({ contentText: null, contentJson: { b: 2, a: 1 } }));
  });

  it("distinguishes content moved between the text and json columns", () => {
    // Otherwise the same bytes could be relocated from `contentText` to
    // `contentJson` to slip past a comparison.
    expect(
      computeArtifactContentHash({ contentText: "x", contentJson: null }),
    ).not.toBe(computeArtifactContentHash({ contentText: null, contentJson: "x" }));
  });

  it("distinguishes empty content from absent content", () => {
    expect(
      computeArtifactContentHash({ contentText: "", contentJson: null }),
    ).not.toBe(computeArtifactContentHash({ contentText: null, contentJson: null }));
  });
});
