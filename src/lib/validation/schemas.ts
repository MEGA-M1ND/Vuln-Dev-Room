import { z } from "zod";

/**
 * Reusable Zod schemas. These are the ONLY place request shapes are defined and
 * are shared by API routes (server validation) and client forms.
 */

export const ticketStatusSchema = z.enum([
  "BACKLOG",
  "IN_PROGRESS",
  "REVIEW",
  "DONE",
]);
export type TicketStatusInput = z.infer<typeof ticketStatusSchema>;

export const ticketPrioritySchema = z.enum([
  "LOW",
  "MEDIUM",
  "HIGH",
  "URGENT",
]);
export type TicketPriorityInput = z.infer<typeof ticketPrioritySchema>;

export const membershipRoleSchema = z.enum(["OWNER", "ENGINEER", "VIEWER"]);

// --- Rooms -------------------------------------------------------------------

// Repository fields are metadata only in Stage 1. We accept a URL string but
// never dereference it (no clone/fetch). Empty strings are normalized to null.
const optionalTrimmed = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));

export const createRoomSchema = z.object({
  name: z.string().trim().min(1, "Room name is required").max(120),
  repositoryName: optionalTrimmed,
  repositoryUrl: z
    .string()
    .trim()
    .max(500)
    .url("Must be a valid URL")
    .optional()
    .or(z.literal(""))
    .transform((v) => (v && v.length > 0 ? v : undefined)),
});
export type CreateRoomInput = z.infer<typeof createRoomSchema>;

export const updateRoomSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    repositoryName: optionalTrimmed,
    repositoryUrl: z
      .string()
      .trim()
      .max(500)
      .url()
      .optional()
      .or(z.literal(""))
      .transform((v) => (v && v.length > 0 ? v : undefined)),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });
export type UpdateRoomInput = z.infer<typeof updateRoomSchema>;

// --- Tickets -----------------------------------------------------------------

export const createTicketSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(5000).optional(),
  status: ticketStatusSchema.default("BACKLOG"),
  priority: ticketPrioritySchema.default("MEDIUM"),
  assigneeId: z.string().cuid().optional().nullable(),
});
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const updateTicketSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    status: ticketStatusSchema.optional(),
    priority: ticketPrioritySchema.optional(),
    assigneeId: z.string().cuid().nullable().optional(),
    // Optimistic concurrency token the client last saw.
    expectedVersion: z.number().int().positive(),
  })
  .refine(
    (v) =>
      Object.keys(v).some(
        (k) => k !== "expectedVersion" && v[k as keyof typeof v] !== undefined,
      ),
    { message: "At least one field to update must be provided" },
  );
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

export const moveTicketSchema = z.object({
  status: ticketStatusSchema,
  // New position within the target column. Optional — server appends to end
  // when omitted.
  position: z.number().optional(),
  expectedVersion: z.number().int().positive(),
});
export type MoveTicketInput = z.infer<typeof moveTicketSchema>;
