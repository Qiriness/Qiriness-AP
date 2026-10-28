/**
 * The people a ticket can be assigned to: every dashboard account with a role
 * that is not disabled, read through `dashboard_team()` (05_ticket_assignment.sql).
 *
 * THROUGH THE DATABASE, NOT THE AUTH ADMIN API. Listing Supabase Auth users
 * directly needs the secret key, and scripts/lib/dashboard-user-admin.mjs — the
 * one holder of it — must never be imported into the web app. The function
 * returns only id, name and role.
 *
 * Accounts are not per shop, so neither is the team. Read once per request.
 *
 * Server-only: it uses the service role. Never import from a client component.
 */
import { cache } from "react";
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import { createSupabaseClient, supabaseRpc } from "../../../scripts/lib/supabase-rest-client.mjs";
import { RPC } from "../../../scripts/lib/tables.mjs";
import type { TeamMember } from "../types";

const ROLES = new Set(["developer", "management", "contact"]);

type TeamRow = { id: string; display_name: string | null; role: string | null; email: string | null };

/** Every row with its address. Server-only: the address never goes to the page. */
const readTeamRows = cache(async (): Promise<TeamRow[]> => {
  const supabase = createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
  return ((await supabaseRpc(supabase, RPC.DASHBOARD_TEAM, {})) as TeamRow[]) ?? [];
});

export const listTeam = cache(async (): Promise<TeamMember[]> =>
  (await readTeamRows()).map((row) => ({
    id: row.id,
    name: row.display_name?.trim() || "—",
    role: row.role && ROLES.has(row.role) ? (row.role as TeamMember["role"]) : null,
  }))
);

/** A team member's name and address, for a forward (06). Null for an unknown or disabled account. */
export async function teamAddress(id: string): Promise<{ name: string; email: string } | null> {
  const row = (await readTeamRows()).find((member) => member.id === id);
  return row?.email ? { name: row.display_name?.trim() || row.email, email: row.email } : null;
}
