"use client";

/**
 * Who a ticket can be assigned to, and who is reading, for every part of the
 * ticket workspace that shows or changes an assignee: the queue's avatars and
 * « Mine » switch, the header's picker, the timeline's « Assigned to » line.
 * Loaded once by the page (`listTeam`, `getSession`).
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { TeamMember } from "@/lib/types";

interface TeamContextValue {
  team: TeamMember[];
  currentUserId: string | null;
  /** The member, or null for an id no longer in the team (a disabled account). */
  memberOf: (id: string | null) => TeamMember | null;
}

const TeamContext = createContext<TeamContextValue>({ team: [], currentUserId: null, memberOf: () => null });

export function TeamProvider({ team, currentUserId, children }: { team: TeamMember[]; currentUserId: string | null; children: ReactNode }) {
  const value = useMemo(() => {
    const byId = new Map(team.map((member) => [member.id, member]));
    return { team, currentUserId, memberOf: (id: string | null) => (id ? byId.get(id) ?? null : null) };
  }, [team, currentUserId]);
  return <TeamContext.Provider value={value}>{children}</TeamContext.Provider>;
}

export function useTeam(): TeamContextValue {
  return useContext(TeamContext);
}

export function initialsOf(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : parts[0]?.slice(0, 2) || "?").toUpperCase();
}
