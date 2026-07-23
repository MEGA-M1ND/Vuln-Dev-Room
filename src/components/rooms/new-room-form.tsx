"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import { createRoomSchema } from "@/lib/validation/schemas";
import { apiFetch } from "@/lib/client/api";
import type { RoomDTO } from "@/lib/types";

export function NewRoomForm() {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const raw = {
      name: String(form.get("name") ?? ""),
      repositoryName: String(form.get("repositoryName") ?? ""),
      repositoryUrl: String(form.get("repositoryUrl") ?? ""),
    };

    const parsed = createRoomSchema.safeParse(raw);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }

    setPending(true);
    try {
      const { room } = await apiFetch<{ room: RoomDTO }>("/api/rooms", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      router.push(`/rooms/${room.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create room");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-1">
        <Label htmlFor="name">Room name</Label>
        <Input
          id="name"
          name="name"
          required
          maxLength={120}
          placeholder="AgentGuard Development"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="repositoryName">Repository name (optional)</Label>
        <Input
          id="repositoryName"
          name="repositoryName"
          maxLength={200}
          placeholder="agentguard-api"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="repositoryUrl">Repository URL (optional)</Label>
        <Input
          id="repositoryUrl"
          name="repositoryUrl"
          type="url"
          maxLength={500}
          placeholder="https://github.com/org/agentguard-api"
        />
        <p className="text-xs text-muted-foreground">
          Metadata only — never cloned or contacted in Stage 1.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <div className="flex gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create room"}
        </Button>
      </div>
    </form>
  );
}
