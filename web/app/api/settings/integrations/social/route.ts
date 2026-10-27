import { NextResponse } from "next/server";
import { ShopChoiceError, integrationShop } from "@/lib/server/integration-shop";
import { getSocialConnections } from "@/lib/server/social-connections-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Meta, Google Ads and TikTok for the shop in `?shop=` (required:
 * integration-shop.ts): configured, connected, which accounts, how the last
 * sync went. Closed to the contact team by the middleware (dashboard-auth.mjs).
 * Never returns a token.
 */
export async function GET(request: Request) {
  try {
    const shop = await integrationShop(request);
    return NextResponse.json(await getSocialConnections(shop.id), { headers: NO_STORE });
  } catch (error) {
    const status = error instanceof ShopChoiceError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status, headers: NO_STORE });
  }
}
