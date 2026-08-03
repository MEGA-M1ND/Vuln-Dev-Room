import { z } from "zod";

/**
 * Centralized, validated environment access. Import from here instead of
 * reading `process.env` directly so that a misconfigured deployment fails
 * fast and loudly rather than at some random request.
 *
 * NOTE: This module is server-only. Never import it into a client component.
 */
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
  // Local-development credential path. A GitHub App is the production shape
  // (see README); this token path is documented as dev-only.
  //
  // .trim() + the refine below exist because of a real incident: a token
  // pasted into a dashboard env var with a trailing newline makes the
  // underlying fetch() throw a header-validation error before any request is
  // sent, which the GitHub client can only see as "Could not reach GitHub" —
  // indistinguishable from a genuine network failure. Reject it here instead,
  // loudly, at startup.
  GITHUB_TOKEN: z
    .string()
    .trim()
    .optional()
    .default("")
    .refine((v) => !/[\r\n\t]/.test(v), {
      message:
        "GITHUB_TOKEN contains a newline/tab character — it was likely pasted " +
        "with extra whitespace, or wrapped in quotes that got included " +
        "literally. Re-paste it without surrounding whitespace.",
    }),
  GITHUB_API_BASE_URL: z
    .string()
    .trim()
    .url()
    .optional()
    .default("https://api.github.com"),

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

export const env = parsed.data;

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
