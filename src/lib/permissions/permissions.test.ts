import { describe, it, expect } from "vitest";

import { can, canMutateTasks, type RoomAction } from "@/lib/permissions";

describe("permissions matrix", () => {
  it("OWNER can do everything including delete and manage memberships", () => {
    const ownerActions: RoomAction[] = [
      "room:read",
      "room:update",
      "membership:manage",
      "task:create",
      "task:edit",
      "task:move",
      "task:assign",
      "task:delete",
      "comment:read",
      "comment:create",
      "presence:view",
    ];
    for (const a of ownerActions) expect(can("OWNER", a)).toBe(true);
  });

  it("ENGINEER can mutate tasks but cannot delete or manage room/members", () => {
    expect(can("ENGINEER", "task:create")).toBe(true);
    expect(can("ENGINEER", "task:edit")).toBe(true);
    expect(can("ENGINEER", "task:move")).toBe(true);
    expect(can("ENGINEER", "task:assign")).toBe(true);
    expect(can("ENGINEER", "comment:create")).toBe(true);

    expect(can("ENGINEER", "task:delete")).toBe(false);
    expect(can("ENGINEER", "room:update")).toBe(false);
    expect(can("ENGINEER", "membership:manage")).toBe(false);
  });

  it("VIEWER can read and comment but cannot mutate tasks", () => {
    expect(can("VIEWER", "room:read")).toBe(true);
    expect(can("VIEWER", "comment:read")).toBe(true);
    expect(can("VIEWER", "comment:create")).toBe(true);
    expect(can("VIEWER", "presence:view")).toBe(true);

    expect(can("VIEWER", "task:create")).toBe(false);
    expect(can("VIEWER", "task:edit")).toBe(false);
    expect(can("VIEWER", "task:move")).toBe(false);
    expect(can("VIEWER", "task:assign")).toBe(false);
    expect(can("VIEWER", "task:delete")).toBe(false);
  });

  it("canMutateTasks reflects role capability", () => {
    expect(canMutateTasks("OWNER")).toBe(true);
    expect(canMutateTasks("ENGINEER")).toBe(true);
    expect(canMutateTasks("VIEWER")).toBe(false);
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

  it("Stage 3: OWNER and ENGINEER can approve a plan; VIEWER cannot", () => {
    expect(can("OWNER", "run:approve")).toBe(true);
    expect(can("ENGINEER", "run:approve")).toBe(true);
    expect(can("VIEWER", "run:approve")).toBe(false);
  });
});
