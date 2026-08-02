"use client";

import * as React from "react";
import type { MembershipRole } from "@prisma/client";

import { useBoard } from "@/components/dev-room/board-context";
import { can } from "@/lib/permissions";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import type { MemberDTO } from "@/lib/types";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/field";

/**
 * Room membership management (OWNER only).
 *
 * The server is the authority on every invariant here — notably that a room
 * always keeps an owner — so the UI simply surfaces the resulting error rather
 * than trying to predict it.
 */
export function MemberManager() {
  const { board, role, refetch } = useBoard();
  const [open, setOpen] = React.useState(false);
  const [members, setMembers] = React.useState<MemberDTO[]>(board.members);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const roomId = board.room.id;

  if (!can(role, "membership:manage")) return null;

  async function reload() {
    try {
      const res = await apiFetch<{ members: MemberDTO[] }>(
        `/api/rooms/${roomId}/members`,
      );
      setMembers(res.members);
      void refetch();
    } catch {
      /* keep current list */
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "That didn't work.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setMembers(board.members);
          setError(null);
          setOpen(true);
        }}
      >
        Manage members
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Room members"
        description="Owners manage the board and members. Engineers can run and steer agents. Viewers can watch and comment."
        className="max-w-2xl"
      >
        <div className="space-y-5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const data = new FormData(form);
              void act(async () => {
                await apiFetch(`/api/rooms/${roomId}/members`, {
                  method: "POST",
                  body: JSON.stringify({
                    email: String(data.get("email") ?? "").trim(),
                    role: String(data.get("role") ?? "ENGINEER"),
                  }),
                });
                form.reset();
              });
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <div className="min-w-[14rem] flex-1 space-y-1">
              <Label htmlFor="member-email">Add by email</Label>
              <Input
                id="member-email"
                name="email"
                type="email"
                required
                placeholder="teammate@example.com"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="member-role">Role</Label>
              <Select id="member-role" name="role" defaultValue="ENGINEER">
                <option value="ENGINEER">Engineer</option>
                <option value="VIEWER">Viewer</option>
              </Select>
            </div>
            <Button type="submit" disabled={pending}>
              Add
            </Button>
          </form>

          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}

          <ul className="divide-y divide-border rounded-md border border-border">
            {members.map((m) => (
              <li key={m.userId} className="flex items-center gap-3 p-3">
                <Avatar name={m.name} id={m.userId} image={m.image} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{m.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {m.email}
                  </p>
                </div>
                <Badge className="capitalize">{m.role.toLowerCase()}</Badge>
                <label className="sr-only" htmlFor={`role-${m.userId}`}>
                  Change role for {m.name}
                </label>
                <Select
                  id={`role-${m.userId}`}
                  value={m.role}
                  disabled={pending}
                  className="h-8 w-28 text-xs"
                  onChange={(e) =>
                    void act(() =>
                      apiFetch(`/api/rooms/${roomId}/members/${m.userId}`, {
                        method: "PATCH",
                        body: JSON.stringify({
                          role: e.target.value as MembershipRole,
                        }),
                      }),
                    )
                  }
                >
                  <option value="OWNER">Owner</option>
                  <option value="ENGINEER">Engineer</option>
                  <option value="VIEWER">Viewer</option>
                </Select>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={pending}
                  onClick={() =>
                    void act(() =>
                      apiFetch(`/api/rooms/${roomId}/members/${m.userId}`, {
                        method: "DELETE",
                      }),
                    )
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            A room always keeps at least one owner, so the final owner cannot be
            removed or demoted.
          </p>
        </div>
      </Dialog>
    </>
  );
}
