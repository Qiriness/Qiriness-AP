import { NextResponse } from "next/server";
import { ShopChoiceError, integrationShop } from "@/lib/server/integration-shop";
import { getSocialConnections, setTracked } from "@/lib/server/social-connections-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PATCH `{enabled}` — track an account of the shop in `?shop=`, or stop. Its
 * stored figures stay either way. 409 when another shop tracks the same account:
 * one account counts for one shop (scripts/lib/social-account-claims.mjs).
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const shop = await integrationShop(request);
    const body = await request.json().catch(() => ({}));
    if (typeof body?.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be true or false" }, { status: 400, headers: NO_STORE });
    }
    const outcome = await setTracked(shop.id, params.id, body.enabled);
    if (outcome === "not_found") return NextResponse.json({ error: "No such account" }, { status: 404, headers: NO_STORE });
    if (outcome === "tracked_elsewhere") {
      return NextResponse.json({ error: "Another shop tracks this account. Switch it off there first.", code: "tracked_elsewhere" }, { status: 409, headers: NO_STORE });
    }
    return NextResponse.json(await getSocialConnections(shop.id), { headers: NO_STORE });
  } catch (error) {
    const status = error instanceof ShopChoiceError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status, headers: NO_STORE });
  }
}
