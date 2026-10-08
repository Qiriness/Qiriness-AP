import { NextResponse } from "next/server";
import { checkPercent, setNonFollowers } from "@/lib/server/social-post-manual-service";
import { isUuid } from "@/lib/server/social-tags-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** PUT `{accountId, postId, percent}` — the share of non-followers a post reached (0–100), typed in by hand; empty or null clears it. */
export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { accountId, postId } = body ?? {};
    if (!isUuid(accountId) || typeof postId !== "string" || !postId) {
      return NextResponse.json({ error: "accountId and postId are required" }, { status: 400, headers: NO_STORE });
    }
    const checked = checkPercent(body?.percent);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400, headers: NO_STORE });
    const found = await setNonFollowers(accountId, postId, checked.percent);
    if (!found) return NextResponse.json({ error: "No such post" }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ ok: true, percent: checked.percent }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}
