import { NextResponse } from "next/server";
import { ShopChoiceError, integrationShop } from "@/lib/server/integration-shop";
import { getSocialConnections, isProvider, queueSync } from "@/lib/server/social-connections-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST — « Sync now » for the shop in `?shop=`. Queues a `sync_social` job under
 * that shop for the worker and answers at once; the dialog shows « queued »
 * until the worker's sync lands. Repeated clicks collapse into the job already
 * queued.
 */
export async function POST(request: Request, { params }: { params: { provider: string } }) {
  if (!isProvider(params.provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 404, headers: NO_STORE });
  try {
    const shop = await integrationShop(request);
    const status = await getSocialConnections(shop.id);
    if (!status.providers.find((p) => p.provider === params.provider)?.connected) {
      return NextResponse.json({ error: "Not connected" }, { status: 409, headers: NO_STORE });
    }
    await queueSync(params.provider, shop.id);
    return NextResponse.json(await getSocialConnections(shop.id), { headers: NO_STORE });
  } catch (error) {
    const status = error instanceof ShopChoiceError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status, headers: NO_STORE });
  }
}
