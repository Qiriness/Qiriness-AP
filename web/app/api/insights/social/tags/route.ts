import { NextResponse } from "next/server";
import { checkTagName, createSocialTag, readSocialTags } from "@/lib/server/social-tags-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** GET — every tag of the shop and the posts it is on. */
export async function GET() {
  return NextResponse.json(await readSocialTags(), { headers: NO_STORE });
}

/** POST `{name}` — a new tag, or the existing one of that name (case ignored). */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const checked = checkTagName(body?.name);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400, headers: NO_STORE });
    return NextResponse.json({ tag: await createSocialTag(checked.name) }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}
