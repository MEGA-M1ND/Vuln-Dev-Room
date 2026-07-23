import type { DefaultSession } from "next-auth";

/**
 * Augment the Auth.js session/JWT with our durable user id.
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
  }
}
