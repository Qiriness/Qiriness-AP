import { NextResponse } from "next/server";
import { getSession } from "@/lib/server/auth";
import { getKlaviyoStatus, removeKlaviyoKey, saveKlaviyoKey } from "@/lib/server/integrations-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The Klaviyo connection. Closed to the contact team by the middleware
 * (dashboard-auth.mjs). No method ever returns the key — only its last four
 * characters and how the last sync went.
 */
export async function GET() {
  try {
    return NextResponse.json(await getKlaviyoStatus(), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}

/** PUT `{key}` — checked against Klaviyo, then stored in Vault. 400 with the reason if refused. */
export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const user = await getSession();
    const result = await saveKlaviyoKey(body?.key, user?.sub ?? null);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400, headers: NO_STORE });
    return NextResponse.json(await getKlaviyoStatus(), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}

/** DELETE — the key leaves Vault; flows and campaigns already synced stay. */
export async function DELETE() {
  try {
    await removeKlaviyoKey();
    return NextResponse.json(await getKlaviyoStatus(), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}
