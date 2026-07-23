import type {
  MembershipRole,
  TicketPriority,
  TicketStatus,
} from "@prisma/client";

/**
 * Serializable DTOs returned by the API and consumed by client components.
 * Dates are ISO strings so they survive JSON round-trips.
 */

export type UserDTO = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

export type MemberDTO = {
  userId: string;
  role: MembershipRole;
  name: string;
  email: string;
  image: string | null;
};

export type RoomDTO = {
  id: string;
  name: string;
  slug: string;
  repositoryName: string | null;
  repositoryUrl: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  role: MembershipRole; // the requesting user's role
};

export type RoomSummaryDTO = RoomDTO & {
  memberCount: number;
  ticketCount: number;
};

export type TicketDTO = {
  id: string;
  roomId: string;
  title: string;
  description: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  assignee: UserDTO | null;
  position: number;
  version: number;
  createdBy: UserDTO;
  createdAt: string;
  updatedAt: string;
};

export type BoardDTO = {
  room: RoomDTO;
  members: MemberDTO[];
  tickets: TicketDTO[];
};
