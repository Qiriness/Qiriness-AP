import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/server/auth";
import { getShopId } from "@/lib/server/knowledge-service";
import { clearDroppedMail, restoreClearedMail } from "@/lib/server/dropped-mail-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

/** Clears blocked emails out of the Irrelevant list for the whole shop. Body: `{ ids: string[] }`. */
export async function POST(request: NextRequest) {
  try {
    const shopId = await getShopId();
    const session = await getSession();
    const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
    const ids = Array.isArray(body?.ids) ? (body!.ids as unknown[]).filter((id): id is string => typeof id === "string") : [];
    const cleared = await clearDroppedMail(shopId, ids, session?.sub ?? null);
    return NextResponse.json({ cleared });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/** « Restore »: every cleared email comes back into the list. */
export async function DELETE() {
  try {
    const shopId = await getShopId();
    await restoreClearedMail(shopId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
