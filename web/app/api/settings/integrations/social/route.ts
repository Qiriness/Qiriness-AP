import { NextResponse } from "next/server";
import { getSocialConnections } from "@/lib/server/social-connections-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Meta and Google Ads: configured, connected, which accounts, how the last sync
 * went. Closed to the contact team by the middleware (dashboard-auth.mjs).
 * Never returns a token.
 */
export async function GET() {
  try {
    return NextResponse.json(await getSocialConnections(), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}
