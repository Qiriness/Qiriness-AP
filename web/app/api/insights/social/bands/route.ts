import { NextResponse } from "next/server";
import { resetBands, saveBands } from "@/lib/server/social-bands-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PUT `{kind, rules: {metric: {mode, low, high}}}` — a platform's colour bands
 * for its post metrics; or `{kind, reset: true}` to go back to the suggestions.
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.reset === true) {
      const found = await resetBands(body?.kind);
      if (!found) return NextResponse.json({ error: "Unknown platform" }, { status: 400, headers: NO_STORE });
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    const saved = await saveBands(body?.kind, body?.rules);
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400, headers: NO_STORE });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}
