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
