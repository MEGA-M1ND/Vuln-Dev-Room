import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";

import { prisma } from "@/lib/db/client";
import { isDevAuthEnabled } from "@/env";

/**
 * Auth.js (NextAuth v5) configuration.
 *
 * Stage 1 uses a DEVELOPMENT-ONLY Credentials provider that signs a user in by
 * email against seeded/known users — no password, so a demo needs no external
 * identity provider. This provider is ONLY registered when `isDevAuthEnabled`
 * is true, which is impossible in production (see `src/env.ts`). Real providers
 * (OAuth/email) can be added later without touching the rest of the app.
 *
 * Sessions use the JWT strategy (required to pair with Credentials) and carry
 * the durable user id so server code can authorize against Postgres.
 */
const devSignInSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120).optional(),
});

const providers = isDevAuthEnabled
  ? [
      Credentials({
        id: "dev",
        name: "Development sign-in",
        credentials: {
          email: { label: "Email", type: "email" },
          name: { label: "Name", type: "text" },
        },
        async authorize(raw) {
          const parsed = devSignInSchema.safeParse(raw);
          if (!parsed.success) return null;
          const { email, name } = parsed.data;

          // Sign in an existing user, or auto-provision one for the demo. This
          // is safe ONLY because the provider itself is dev-gated.
          const user = await prisma.user.upsert({
            where: { email },
            update: {},
            create: { email, name: name ?? email.split("@")[0]! },
          });

          return {
            id: user.id,
            name: user.name,
            email: user.email,
            image: user.image,
          };
        },
      }),
    ]
  : [];

export const authConfig = {
  providers,
  // Self-hosted deployments are not behind Auth.js's built-in host allowlist
  // (which is Vercel-aware), so we trust the host explicitly. Override per
  // environment with AUTH_TRUST_HOST if you place the app behind a proxy.
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/" },
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.userId = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.userId && session.user) {
        session.user.id = token.userId as string;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
