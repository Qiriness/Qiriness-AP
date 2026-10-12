import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { ROLE_LABELS } from "../../../../../scripts/lib/dashboard-auth.mjs";
import { markCurrentShop, parseShopLinks } from "../../../../../scripts/lib/shop-links.mjs";
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
  // Links to the other shops' dashboards (SHOP_LINKS). Separate deployments with
  // separate accounts, so these are plain links, not a session switch.
  const shops = markCurrentShop(parseShopLinks(process.env.SHOP_LINKS), headers().get("host"));
  return NextResponse.json(
    { email: user.email, displayName: user.displayName, role: user.role, roleLabel: ROLE_LABELS[user.role], shops },
    { headers: { "Cache-Control": "no-store" } }
  );
}
