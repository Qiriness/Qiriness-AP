import { NextResponse } from "next/server";
import { ShopChoiceError, integrationShop } from "@/lib/server/integration-shop";
import { disconnect, getSocialConnections, isProvider } from "@/lib/server/social-connections-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * DELETE — the provider's token for the shop in `?shop=` leaves Vault. Accounts
 * and everything synced stay, so the panel keeps its history; connecting again
 * resumes the sync. (The static `klaviyo/` route beside this one takes
 * precedence over it.)
 */
export async function DELETE(request: Request, { params }: { params: { provider: string } }) {
  if (!isProvider(params.provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 404, headers: NO_STORE });
  try {
    const shop = await integrationShop(request);
    await disconnect(params.provider, shop.id);
    return NextResponse.json(await getSocialConnections(shop.id), { headers: NO_STORE });
  } catch (error) {
    const status = error instanceof ShopChoiceError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status, headers: NO_STORE });
  }
}
