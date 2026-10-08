import { NextResponse } from "next/server";
import { isUuid, setPostTag } from "@/lib/server/social-tags-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** PUT `{accountId, postId, tagged}` — put the tag on a post, or take it off. */
export async function PUT(request: Request, { params }: { params: { id: string } }) {
  try {
    const body = await request.json().catch(() => ({}));
    const { accountId, postId, tagged } = body ?? {};
    if (!isUuid(accountId) || typeof postId !== "string" || !postId || typeof tagged !== "boolean") {
      return NextResponse.json({ error: "accountId, postId and tagged are required" }, { status: 400, headers: NO_STORE });
    }
    if (!isUuid(params.id)) return NextResponse.json({ error: "No such tag or post" }, { status: 404, headers: NO_STORE });
    const found = await setPostTag(params.id, accountId, postId, tagged);
    if (!found) return NextResponse.json({ error: "No such tag or post" }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}
