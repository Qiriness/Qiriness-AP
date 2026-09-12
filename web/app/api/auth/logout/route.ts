import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ACCESS_COOKIE, authClient } from "../../../../../scripts/lib/dashboard-auth.mjs";
import { clearSession } from "@/lib/session-cookies";

export const dynamic = "force-dynamic";

/**
 * POST — sign out.
 *
 * Supabase is told first, so the refresh token is dead server-side and not
 * merely dropped by this browser; then the cookies go.
 */
export async function POST() {
  const token = cookies().get(ACCESS_COOKIE)?.value;
  if (token) await authClient(process.env)?.signOut(token);

  const response = NextResponse.json({ ok: true, next: "/login" }, { headers: { "Cache-Control": "no-store" } });
  clearSession(response);
  return response;
}
