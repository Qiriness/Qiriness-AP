import { NextResponse } from "next/server";
import { saveChatCaps } from "../../../../../scripts/lib/storefront-chat/chat-caps.mjs";
import { getSupabaseClient } from "@/lib/server/insights/shared";
import { advisorShops } from "@/lib/server/storefront-agent/dashboard-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The storefront chat's two caps for one advisor shop (chat-caps.mjs).
 * PUT `{ shop, daily, session }`: each a whole number within its bounds, or
 * empty for the default. Only a shop the advisor answers
 * (STOREFRONT_CHAT_ALLOWED_SHOPS). Closed to the contact team with the
 * Storefront Agent page (dashboard-auth.mjs).
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const shop = typeof body?.shop === "string" ? body.shop.trim().toLowerCase() : "";
    if (!advisorShops().includes(shop)) {
      return NextResponse.json({ error: "Not a shop the storefront advisor answers." }, { status: 400, headers: NO_STORE });
    }
    const result = (await saveChatCaps(getSupabaseClient(), shop, { daily: body?.daily, session: body?.session })) as
      | { ok: true; value: { daily: number | null; session: number | null } }
      | { ok: false; error: string };
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400, headers: NO_STORE });
    return NextResponse.json(result.value, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500, headers: NO_STORE });
  }
}
