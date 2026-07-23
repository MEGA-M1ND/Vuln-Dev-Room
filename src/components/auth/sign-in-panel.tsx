"use client";

import * as React from "react";

import { devSignInAction } from "@/lib/auth/actions";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";

export interface SeedUserOption {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

/**
 * Development user switcher. Renders known seeded users as one-click sign-in
 * buttons, plus a free-form form to sign in / provision any email. Only shown
 * when dev auth is enabled (the server action is independently guarded).
 */
export function SignInPanel({ users }: { users: SeedUserOption[] }) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await devSignInAction(formData);
      if (result?.error) setError(result.error);
    });
  }

  return (
    <div className="w-full max-w-md space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Sign in to Dev Room</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Development sign-in — pick a seeded teammate or enter any email. Open a
          second browser and sign in as a different user to test collaboration.
        </p>
      </div>

      {users.length > 0 ? (
        <div className="space-y-2">
          <Label>Quick sign-in</Label>
          <ul className="grid gap-2">
            {users.map((u) => (
              <li key={u.id}>
                <form action={submit}>
                  <input type="hidden" name="email" value={u.email} />
                  <input type="hidden" name="name" value={u.name} />
                  <button
                    type="submit"
                    disabled={pending}
                    className="flex w-full items-center gap-3 rounded-md border border-border p-3 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <Avatar name={u.name} id={u.id} image={u.image} />
                    <span>
                      <span className="block text-sm font-medium">
                        {u.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {u.email}
                      </span>
                    </span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="relative">
        <div className="absolute inset-0 flex items-center" aria-hidden="true">
          <div className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs">
          <span className="bg-background px-2 text-muted-foreground">
            or use any email
          </span>
        </div>
      </div>

      <form action={submit} className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="name">Display name</Label>
          <Input id="name" name="name" placeholder="Jordan Rivera" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            required
            placeholder="jordan@devroom.local"
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
