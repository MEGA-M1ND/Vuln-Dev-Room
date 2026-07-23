import { describe, it, expect } from "vitest";

import {
  createTicketSchema,
  updateTicketSchema,
  moveTicketSchema,
  createRoomSchema,
} from "@/lib/validation/schemas";

describe("createTicketSchema", () => {
  it("requires a non-empty title", () => {
    expect(createTicketSchema.safeParse({ title: "" }).success).toBe(false);
    expect(createTicketSchema.safeParse({}).success).toBe(false);
  });

  it("applies defaults for status and priority", () => {
    const parsed = createTicketSchema.parse({ title: "Do the thing" });
    expect(parsed.status).toBe("BACKLOG");
    expect(parsed.priority).toBe("MEDIUM");
  });

  it("rejects invalid status/priority enums", () => {
    expect(
      createTicketSchema.safeParse({ title: "x", status: "NOPE" }).success,
    ).toBe(false);
    expect(
      createTicketSchema.safeParse({ title: "x", priority: "SUPER" }).success,
    ).toBe(false);
  });

  it("trims and enforces the title length limit", () => {
    const parsed = createTicketSchema.parse({ title: "  padded  " });
    expect(parsed.title).toBe("padded");
    expect(
      createTicketSchema.safeParse({ title: "a".repeat(201) }).success,
    ).toBe(false);
  });
});

describe("updateTicketSchema", () => {
  it("requires expectedVersion", () => {
    expect(updateTicketSchema.safeParse({ title: "new" }).success).toBe(false);
  });

  it("requires expectedVersion to be a positive integer", () => {
    expect(
      updateTicketSchema.safeParse({ title: "x", expectedVersion: 0 }).success,
    ).toBe(false);
    expect(
      updateTicketSchema.safeParse({ title: "x", expectedVersion: -1 }).success,
    ).toBe(false);
  });

  it("rejects an update with only expectedVersion and no fields", () => {
    expect(updateTicketSchema.safeParse({ expectedVersion: 1 }).success).toBe(
      false,
    );
  });

  it("accepts a valid partial update", () => {
    const parsed = updateTicketSchema.parse({
      priority: "HIGH",
      expectedVersion: 3,
    });
    expect(parsed.priority).toBe("HIGH");
    expect(parsed.expectedVersion).toBe(3);
  });

  it("allows clearing the assignee with null", () => {
    const parsed = updateTicketSchema.parse({
      assigneeId: null,
      expectedVersion: 1,
    });
    expect(parsed.assigneeId).toBeNull();
  });
});

describe("moveTicketSchema", () => {
  it("requires status and expectedVersion", () => {
    expect(moveTicketSchema.safeParse({ status: "DONE" }).success).toBe(false);
    expect(moveTicketSchema.safeParse({ expectedVersion: 1 }).success).toBe(
      false,
    );
  });

  it("accepts an optional position", () => {
    const parsed = moveTicketSchema.parse({
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
