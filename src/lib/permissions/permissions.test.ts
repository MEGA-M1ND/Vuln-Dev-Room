import { describe, it, expect } from "vitest";

import { can, canMutateTickets, type RoomAction } from "@/lib/permissions";

describe("permissions matrix", () => {
  it("OWNER can do everything including delete and manage memberships", () => {
    const ownerActions: RoomAction[] = [
      "room:read",
      "room:update",
      "membership:manage",
      "ticket:create",
      "ticket:edit",
      "ticket:move",
      "ticket:assign",
      "ticket:delete",
      "comment:read",
      "comment:create",
      "presence:view",
    ];
    for (const a of ownerActions) expect(can("OWNER", a)).toBe(true);
  });

  it("ENGINEER can mutate tickets but cannot delete or manage room/members", () => {
    expect(can("ENGINEER", "ticket:create")).toBe(true);
    expect(can("ENGINEER", "ticket:edit")).toBe(true);
    expect(can("ENGINEER", "ticket:move")).toBe(true);
    expect(can("ENGINEER", "ticket:assign")).toBe(true);
    expect(can("ENGINEER", "comment:create")).toBe(true);

    expect(can("ENGINEER", "ticket:delete")).toBe(false);
    expect(can("ENGINEER", "room:update")).toBe(false);
    expect(can("ENGINEER", "membership:manage")).toBe(false);
  });

  it("VIEWER can read and comment but cannot mutate tickets", () => {
    expect(can("VIEWER", "room:read")).toBe(true);
    expect(can("VIEWER", "comment:read")).toBe(true);
    expect(can("VIEWER", "comment:create")).toBe(true);
    expect(can("VIEWER", "presence:view")).toBe(true);

    expect(can("VIEWER", "ticket:create")).toBe(false);
    expect(can("VIEWER", "ticket:edit")).toBe(false);
    expect(can("VIEWER", "ticket:move")).toBe(false);
    expect(can("VIEWER", "ticket:assign")).toBe(false);
    expect(can("VIEWER", "ticket:delete")).toBe(false);
  });

  it("canMutateTickets reflects role capability", () => {
    expect(canMutateTickets("OWNER")).toBe(true);
    expect(canMutateTickets("ENGINEER")).toBe(true);
    expect(canMutateTickets("VIEWER")).toBe(false);
  });

  it("agent runs: OWNER and ENGINEER can start; VIEWER cannot", () => {
    expect(can("OWNER", "run:create")).toBe(true);
    expect(can("ENGINEER", "run:create")).toBe(true);
    expect(can("VIEWER", "run:create")).toBe(false);
  });

  it("agent runs: all roles can read runs", () => {
    expect(can("OWNER", "run:read")).toBe(true);
    expect(can("ENGINEER", "run:read")).toBe(true);
    expect(can("VIEWER", "run:read")).toBe(true);
  });
});
