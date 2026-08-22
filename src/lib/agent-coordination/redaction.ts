/**
 * Secret detection for agent-published content.
 *
 * Discoveries are written by agents that have just been reading a repository,
 * its environment and its command output. The likeliest way a credential ends
 * up in this database is not malice — it is an agent helpfully pasting the
 * config file it just found. This module is the control that stops that.
 *
 * TWO POSTURES, deliberately different:
 *
 *  - HIGH-CONFIDENCE patterns (a private key block, an AWS access key id, a
 *    GitHub/Slack/Stripe token) REJECT the whole publish. These have almost no
 *    false-positive rate, and silently storing a redacted version of a real
 *    leaked credential would hide an incident someone needs to know about.
 *
 *  - HEURISTIC patterns (`API_KEY=…`, `Authorization: Bearer …`) REDACT the
 *    matched span and set `redacted`. These do fire on harmless text — a
 *    docs example, a variable name in a diff — so rejecting on them would make
 *    the tool unusable for exactly the security work it exists to coordinate.
 *
 * This is a filter, not a guarantee. It catches the shapes people actually
 * leak; it cannot catch a secret that looks like prose. Defence in depth: the
 * schemas bound size, this bounds content, and nothing here is a substitute
 * for agents not being handed credentials they do not need.
 */

export type RedactionFinding = {
  /** Stable rule name, safe to log and to return to the caller. */
  rule: string;
  /** Human-readable reason. Never contains the matched secret. */
  reason: string;
};

export type RedactionResult =
  | { ok: true; content: string; redacted: boolean; findings: RedactionFinding[] }
  | { ok: false; findings: RedactionFinding[] };

const PLACEHOLDER = "[REDACTED]";

type Rule = {
  name: string;
  reason: string;
  pattern: RegExp;
  /** true → refuse the publish outright; false → redact and continue. */
  reject: boolean;
};

/**
 * Order matters only for reporting; every rule is evaluated. Patterns are
 * written with `g` so `replace` can redact every occurrence, and are recreated
 * per call (see `freshPattern`) because a `g` regex carries mutable
 * `lastIndex` state that would otherwise leak between calls.
 */
const RULES: readonly Rule[] = [
  {
    name: "private_key_block",
    reason: "Content contains a PEM private key block.",
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----/g,
    reject: true,
  },
  {
    name: "aws_access_key_id",
    reason: "Content contains what looks like an AWS access key id.",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    reject: true,
  },
  {
    name: "github_token",
    reason: "Content contains what looks like a GitHub token.",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    reject: true,
  },
  {
    name: "slack_token",
    reason: "Content contains what looks like a Slack token.",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    reject: true,
  },
  {
    name: "stripe_secret_key",
    reason: "Content contains what looks like a Stripe secret key.",
    pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    reject: true,
  },
  {
    name: "openai_api_key",
    reason: "Content contains what looks like an OpenAI API key.",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    reject: true,
  },
  {
    name: "json_web_token",
    reason: "Content contains what looks like a signed JSON Web Token.",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    reject: true,
  },
  // --- Heuristic: redact, do not reject -------------------------------------
  {
    name: "authorization_header",
    reason: "An Authorization header value was redacted.",
    pattern: /\b(?:Authorization\s*:\s*)?(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    reject: false,
  },
  {
    name: "assigned_secret_variable",
    // KEY=value / "token": "value" — the shape of a leaked env var or config
    // entry. Requires a plausible value length so `API_KEY=` alone (a mention,
    // not a leak) does not fire.
    reason: "A secret-looking variable assignment was redacted.",
    pattern:
      /\b[A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Za-z0-9_]*\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi,
    reject: false,
  },
  {
    name: "connection_string_password",
    reason: "A URL containing inline credentials was redacted.",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@[^\s]+/gi,
    reject: false,
  },
];

function freshPattern(rule: Rule): RegExp {
  return new RegExp(rule.pattern.source, rule.pattern.flags);
}

/**
 * Scan and, where appropriate, redact. Returns `ok: false` when the content
 * tripped a high-confidence rule and must not be stored at all.
 *
 * `findings` never contains the matched text — only the rule that fired, so an
 * error message returned to the caller (or written to a log) cannot itself
 * become the leak.
 */
export function scanAndRedact(input: string): RedactionResult {
  const rejections: RedactionFinding[] = [];

  for (const rule of RULES) {
    if (!rule.reject) continue;
    if (freshPattern(rule).test(input)) {
      rejections.push({ rule: rule.name, reason: rule.reason });
    }
  }
  if (rejections.length > 0) return { ok: false, findings: rejections };

  let content = input;
  const findings: RedactionFinding[] = [];
  for (const rule of RULES) {
    if (rule.reject) continue;
    const pattern = freshPattern(rule);
    if (!pattern.test(content)) continue;
    content = content.replace(freshPattern(rule), PLACEHOLDER);
    findings.push({ rule: rule.name, reason: rule.reason });
  }

  return { ok: true, content, redacted: findings.length > 0, findings };
}

/**
 * Scan several fields as one unit: a discovery's body and each of its evidence
 * excerpts. Either the whole publish is refused, or every field comes back
 * cleaned — a discovery whose body was accepted but whose evidence still
 * carried a key would defeat the point.
 */
export function scanAndRedactMany(
  inputs: ReadonlyArray<string | null | undefined>,
): | { ok: true; values: Array<string | null>; redacted: boolean; findings: RedactionFinding[] }
  | { ok: false; findings: RedactionFinding[] } {
  const values: Array<string | null> = [];
  const findings: RedactionFinding[] = [];
  let redacted = false;

  for (const raw of inputs) {
    if (raw === null || raw === undefined) {
      values.push(null);
      continue;
    }
    const result = scanAndRedact(raw);
    if (!result.ok) return { ok: false, findings: result.findings };
    values.push(result.content);
    if (result.redacted) redacted = true;
    findings.push(...result.findings);
  }

  return { ok: true, values, redacted, findings };
}
