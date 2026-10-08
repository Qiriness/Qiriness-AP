import { NextResponse } from "next/server";
import { setEngagementBasis } from "@/lib/server/social-connections-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** PUT `{kind, basis}` — which denominator a platform's engagement rate uses: followers, reach or views. */
export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const found = await setEngagementBasis(body?.kind, body?.basis);
    if (!found) return NextResponse.json({ error: "Unknown platform or basis" }, { status: 400, headers: NO_STORE });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}
