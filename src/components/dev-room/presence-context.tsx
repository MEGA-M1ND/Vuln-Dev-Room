"use client";

import * as React from "react";
import type { MembershipRole } from "@prisma/client";

/**
 * A Liveblocks-agnostic presence surface consumed by the roster, avatar stack
 * and ticket viewers. When Liveblocks is configured, `LiveblocksPresenceBridge`
 * fills this from live data. When it is not, `StaticPresenceProvider` supplies
 * an empty/disabled surface so the rest of the UI renders unchanged.
 */
export type PresenceUser = {
  connectionId: number;
  id: string;
  name: string;
  avatar?: string;
  color: string;
  role: MembershipRole;
  selectedTicketId: string | null;
  activity: string | null;
};

export type PresenceContextValue = {
  enabled: boolean;
  others: PresenceUser[];
  onlineUserIds: Set<string>;
  viewersOf: (ticketId: string) => PresenceUser[];
};

const PresenceContext = React.createContext<PresenceContextValue | null>(null);

export function usePresence(): PresenceContextValue {
  const ctx = React.useContext(PresenceContext);
  if (!ctx) throw new Error("usePresence must be used within a PresenceProvider");
  return ctx;
}

export function PresenceProvider({
  value,
  children,
}: {
  value: PresenceContextValue;
  children: React.ReactNode;
}) {
  return (
    <PresenceContext.Provider value={value}>
      {children}
    </PresenceContext.Provider>
  );
}

/** Used when Liveblocks is not configured — presence is simply unavailable. */
export function StaticPresenceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const value = React.useMemo<PresenceContextValue>(
    () => ({
      enabled: false,
      others: [],
      onlineUserIds: new Set<string>(),
      viewersOf: () => [],
    }),
    [],
  );
  return <PresenceProvider value={value}>{children}</PresenceProvider>;
}
