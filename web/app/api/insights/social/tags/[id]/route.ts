import { NextResponse } from "next/server";
import { deleteSocialTag, isUuid } from "@/lib/server/social-tags-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** DELETE — the tag, and with it every place it was applied. */
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    if (!isUuid(params.id)) return NextResponse.json({ error: "No such tag" }, { status: 404, headers: NO_STORE });
    const found = await deleteSocialTag(params.id);
    if (!found) return NextResponse.json({ error: "No such tag" }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}
