/**
 * The signed-in user, as server code sees them.
 *
 * It re-checks the cookie rather than trusting anything the middleware passed
 * down: a header can be set by whoever sends the request, and one bypass of the
 * middleware would then be a bypass of every page guard too. The check is the
 * same one the middleware makes — a local signature check, then a Supabase read
 * cached for a minute — so this costs no round trip on most requests.
 *
 * Server-only.
 */

import { cookies } from "next/headers";
import { ACCESS_COOKIE, authClient } from "../../../scripts/lib/dashboard-auth.mjs";

export type Role = "developer" | "management" | "contact";

export interface CurrentUser {
  /** The Supabase user id — what `data_access_events.actor_id` records. */
  sub: string;
  email: string | null;
  displayName: string | null;
  role: Role;
}

export async function getSession(): Promise<CurrentUser | null> {
  const auth = authClient(process.env);
  const token = cookies().get(ACCESS_COOKIE)?.value;
  if (!auth || !token) return null;
  const session = await auth.verifyAccessToken(token);
  if (!session.ok) return null;
  return {
    sub: session.user.id,
    email: session.user.email,
    displayName: session.user.displayName,
    role: session.user.role as Role,
  };
}
