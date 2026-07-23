"use server";

import { AuthError } from "next-auth";

import { signIn, signOut } from "@/auth";
import { isDevAuthEnabled } from "@/env";

/**
 * Development-only sign-in. Guarded server-side: throws if dev auth is off, so
 * this can never authenticate anyone in production.
 */
export async function devSignInAction(
  formData: FormData,
): Promise<{ error: string } | void> {
  if (!isDevAuthEnabled) {
    return { error: "Development sign-in is disabled." };
  }
  const email = String(formData.get("email") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!email) return { error: "Email is required." };

  try {
    await signIn("dev", {
      email,
      name: name || undefined,
      redirectTo: "/rooms",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "Could not sign in with those details." };
    }
    // `signIn` throws a redirect on success — rethrow so Next handles it.
    throw error;
  }
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/" });
}
