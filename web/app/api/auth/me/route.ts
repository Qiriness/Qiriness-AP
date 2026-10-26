import { NextResponse } from "next/server";
import { ROLE_LABELS } from "../../../../../scripts/lib/dashboard-auth.mjs";
import { getSession } from "@/lib/server/auth";
import { clearSession } from "@/lib/session-cookies";

export const dynamic = "force-dynamic";

/**
 * GET — who is signed in. Called by the top bar on every page.
 *
 * A 401 here is the browser's cue to go back to /login: the middleware would
 * have caught a bad session already, so this answers 401 only for one that
 * stopped being valid between the two checks.
 */
export async function GET() {
  const user = await getSession();
  if (!user) {
    const response = NextResponse.json(
      { error: "Not signed in." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
    clearSession(response);
    return response;
  }
  return NextResponse.json(
    { email: user.email, displayName: user.displayName, role: user.role, roleLabel: ROLE_LABELS[user.role] },
    { headers: { "Cache-Control": "no-store" } }
  );
}
