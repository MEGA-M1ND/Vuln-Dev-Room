import { describe, it, expect } from "vitest";

import {
  createTaskSchema,
  updateTaskSchema,
  moveTaskSchema,
  createRoomSchema,
} from "@/lib/validation/schemas";

describe("createTaskSchema", () => {
  it("requires a non-empty title", () => {
    expect(createTaskSchema.safeParse({ title: "" }).success).toBe(false);
    expect(createTaskSchema.safeParse({}).success).toBe(false);
  });

  it("applies defaults for status and priority", () => {
    const parsed = createTaskSchema.parse({ title: "Do the thing" });
    expect(parsed.status).toBe("BACKLOG");
    expect(parsed.priority).toBe("MEDIUM");
  });

  it("rejects invalid status/priority enums", () => {
    expect(
      createTaskSchema.safeParse({ title: "x", status: "NOPE" }).success,
    ).toBe(false);
    expect(
      createTaskSchema.safeParse({ title: "x", priority: "SUPER" }).success,
    ).toBe(false);
  });

  it("trims and enforces the title length limit", () => {
    const parsed = createTaskSchema.parse({ title: "  padded  " });
    expect(parsed.title).toBe("padded");
    expect(
      createTaskSchema.safeParse({ title: "a".repeat(201) }).success,
    ).toBe(false);
  });
});

describe("updateTaskSchema", () => {
  it("requires expectedVersion", () => {
    expect(updateTaskSchema.safeParse({ title: "new" }).success).toBe(false);
  });

  it("requires expectedVersion to be a positive integer", () => {
    expect(
      updateTaskSchema.safeParse({ title: "x", expectedVersion: 0 }).success,
    ).toBe(false);
    expect(
      updateTaskSchema.safeParse({ title: "x", expectedVersion: -1 }).success,
    ).toBe(false);
  });

  it("rejects an update with only expectedVersion and no fields", () => {
    expect(updateTaskSchema.safeParse({ expectedVersion: 1 }).success).toBe(
      false,
    );
  });

  it("accepts a valid partial update", () => {
    const parsed = updateTaskSchema.parse({
      priority: "HIGH",
      expectedVersion: 3,
    });
    expect(parsed.priority).toBe("HIGH");
    expect(parsed.expectedVersion).toBe(3);
  });

  it("allows clearing the assignee with null", () => {
    const parsed = updateTaskSchema.parse({
      assigneeId: null,
      expectedVersion: 1,
    });
    expect(parsed.assigneeId).toBeNull();
  });
});

describe("moveTaskSchema", () => {
  it("requires status and expectedVersion", () => {
    expect(moveTaskSchema.safeParse({ status: "DONE" }).success).toBe(false);
    expect(moveTaskSchema.safeParse({ expectedVersion: 1 }).success).toBe(
      false,
    );
  });

  it("accepts an optional position", () => {
    const parsed = moveTaskSchema.parse({
      status: "REVIEW",
      expectedVersion: 2,
      position: 1500,
    });
    expect(parsed.position).toBe(1500);
  });
});

describe("createRoomSchema", () => {
  it("requires a name", () => {
    expect(createRoomSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects a malformed repository URL but allows empty", () => {
    expect(
      createRoomSchema.safeParse({ name: "R", repositoryUrl: "not-a-url" })
        .success,
    ).toBe(false);
    const ok = createRoomSchema.parse({ name: "R", repositoryUrl: "" });
    expect(ok.repositoryUrl).toBeUndefined();
  });
});
