"use client";

import { githubSignInAction } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";

export function GitHubSignInButton() {
  return (
    <form action={githubSignInAction}>
      <Button type="submit" className="w-full">
        Sign in with GitHub
      </Button>
    </form>
  );
}
