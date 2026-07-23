import { auth } from "@/auth";
import { ApiError } from "@/lib/api/errors";

export type SessionUser = {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
};

/** Returns the signed-in user or null. Server-only. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    image: session.user.image ?? null,
  };
}

/** Returns the signed-in user or throws a 401 ApiError. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new ApiError("UNAUTHENTICATED", "You must be signed in.");
  }
  return user;
}
