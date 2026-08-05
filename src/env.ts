import { z } from "zod";

/**
 * Centralized, validated environment access. Import from here instead of
 * reading `process.env` directly so that a misconfigured deployment fails
 * fast and loudly rather than at some random request.
 *
 * NOTE: This module is server-only. Never import it into a client component.
 */

/**
 * HTTP header values are serialized as a ByteString: every character must be
 * a single byte (code point 0–255). `fetch()` throws a TypeError before
 * sending anything if that's violated — a token containing even one such
 * character (e.g. "•", U+2022) surfaces downstream as an opaque
 * "Could not reach GitHub" with no indication of the real cause. Finding the
 * exact offending character lets `validateGithubToken()` below log a
 * specific, actionable diagnostic instead.
 */
function firstInvalidHeaderChar(value: string): { index: number; code: number } | null {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 255) return { index: i, code };
  }
  return null;
}
const serverSchema = z.object({
  DATABASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(1, "AUTH_SECRET is required"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DEV_AUTH_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  LIVEBLOCKS_SECRET_KEY: z.string().optional().default(""),

  // --- GitHub OAuth sign-in (the only production auth provider) ---
  AUTH_GITHUB_ID: z.string().optional().default(""),
  AUTH_GITHUB_SECRET: z.string().optional().default(""),

  // --- Stage 2: agent runtime (server-only) ---
  // Base URL of the internal Python agent-runtime service.
  DEVROOM_AGENT_SERVICE_URL: z
    .string()
    .url()
    .optional()
    .default("http://127.0.0.1:8787"),
  // Shared internal service token. Must match the runtime's token.
  DEVROOM_AGENT_SERVICE_TOKEN: z.string().optional().default(""),
  // The repository registry key runs default to. The runtime validates keys
  // against its own registry; the browser never sends a filesystem path.
  DEVROOM_DEFAULT_REPOSITORY_KEY: z
    .string()
    .optional()
    .default("agentguard-demo"),

  // --- MVP Phase 3: GitHub delivery (optional, OFF by default) ---
  // The whole integration is gated on this flag; without it the product runs
  // exactly as before and the UI shows a clear "not configured" state.
  DEVROOM_GITHUB_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  // GITHUB_TOKEN and GITHUB_API_BASE_URL are deliberately NOT validated here —
  // see validateGithubToken()/validateGithubApiBaseUrl() below.

  // --- MVP Phase 6: demo affordances (never on in production) ---
  DEVROOM_DEMO_MODE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

const parsed = serverSchema.safeParse(process.env);

if (!parsed.success) {
  // Do not print values — only which keys are invalid.
  console.error(
    "[env] Invalid server environment:",
    parsed.error.flatten().fieldErrors,
  );
  throw new Error("Invalid server environment. See logs above.");
}

/**
 * GITHUB_TOKEN and GITHUB_API_BASE_URL are validated here rather than inside
 * `serverSchema` above, and deliberately never throw.
 *
 * GitHub delivery is an OPTIONAL integration (`isGitHubConfigured`) — an
 * absent token already degrades gracefully to "not configured," and a
 * corrupted one must degrade exactly the same way, not take the entire
 * application down. Putting this validation inside the strict, throwing
 * schema was itself the bug behind a real incident: a single bad character in
 * an optional third-party credential failed the whole production build
 * (`Failed to collect page data for /api/liveblocks-auth`), even though
 * nothing about that route touches GitHub. The specific diagnostic is still
 * logged loudly server-side — it's just a warning that disables the feature,
 * not a fatal error that disables the product.
 */
function validateGithubToken(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (/[\r\n\t]/.test(value)) {
    console.error(
      "[env] GITHUB_TOKEN contains a newline/tab character — it was likely " +
        "pasted with extra whitespace, or wrapped in quotes that got included " +
        "literally. Treating GitHub as unconfigured until it is re-pasted " +
        "without surrounding whitespace.",
    );
    return "";
  }
  const bad = firstInvalidHeaderChar(value);
  if (bad) {
    console.error(
      `[env] GITHUB_TOKEN contains a character that is not valid in an HTTP ` +
        `header (code point ${bad.code} at position ${bad.index}). This is ` +
        `usually a copy-paste artifact — e.g. copying a masked/obscured token ` +
        `instead of its real value. Treating GitHub as unconfigured until it ` +
        `is re-copied directly from GitHub's token page.`,
    );
    return "";
  }
  return value;
}

function validateGithubApiBaseUrl(raw: string | undefined): string {
  const fallback = "https://api.github.com";
  const value = (raw ?? "").trim();
  if (!value) return fallback;
  try {
    new URL(value);
    return value;
  } catch {
    console.error(
      `[env] GITHUB_API_BASE_URL (${JSON.stringify(value)}) is not a valid URL — ` +
        `falling back to ${fallback}.`,
    );
    return fallback;
  }
}

export const env = {
  ...parsed.data,
  GITHUB_TOKEN: validateGithubToken(process.env.GITHUB_TOKEN),
  GITHUB_API_BASE_URL: validateGithubApiBaseUrl(process.env.GITHUB_API_BASE_URL),
};

/**
 * The development auth switcher is ONLY available outside production and only
 * when explicitly opted in. This guard is enforced server-side so it can never
 * be turned on by a client.
 */
export const isDevAuthEnabled =
  env.NODE_ENV !== "production" && env.DEV_AUTH_ENABLED === true;

export const isLiveblocksConfigured = env.LIVEBLOCKS_SECRET_KEY.length > 0;

/** GitHub OAuth is the only sign-in path available in production. */
export const isGitHubOAuthConfigured =
  env.AUTH_GITHUB_ID.length > 0 && env.AUTH_GITHUB_SECRET.length > 0;

/** Whether the agent runtime is wired up (a service token is configured). */
export const isAgentRuntimeConfigured =
  env.DEVROOM_AGENT_SERVICE_TOKEN.length > 0;

/**
 * GitHub delivery requires BOTH the explicit feature flag and a credential.
 * Anything less is treated as "not configured" so the UI never implies a
 * working integration that would fail on use.
 */
export const isGitHubConfigured =
  env.DEVROOM_GITHUB_ENABLED === true && env.GITHUB_TOKEN.length > 0;

/** Demo-only affordances (e.g. sample ticket seeding). Never in production. */
export const isDemoMode =
  env.NODE_ENV !== "production" && env.DEVROOM_DEMO_MODE === true;
