import { NextResponse } from "next/server";
import { getSession } from "@/lib/server/auth";
import { ShopChoiceError, integrationShop } from "@/lib/server/integration-shop";
import { getKlaviyoStatus, removeKlaviyoKey, saveKlaviyoKey } from "@/lib/server/integrations-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The Klaviyo connection of the shop in `?shop=` (required: integration-shop.ts).
 * Closed to the contact team by the middleware (dashboard-auth.mjs). No method
 * ever returns the key — only its last four characters and how the last sync
 * went.
 */
export async function GET(request: Request) {
  try {
    const shop = await integrationShop(request);
    return NextResponse.json(await getKlaviyoStatus(shop.id), { headers: NO_STORE });
  } catch (error) {
    return failed(error);
  }
}

/** PUT `{key}` — checked against Klaviyo, then stored in Vault. 400 with the reason if refused. */
export async function PUT(request: Request) {
  try {
    const shop = await integrationShop(request);
    const body = await request.json().catch(() => ({}));
    const user = await getSession();
    const result = await saveKlaviyoKey(shop.id, body?.key, user?.sub ?? null);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400, headers: NO_STORE });
    return NextResponse.json(await getKlaviyoStatus(shop.id), { headers: NO_STORE });
  } catch (error) {
    return failed(error);
  }
}

/** DELETE — the key leaves Vault; flows and campaigns already synced stay. */
export async function DELETE(request: Request) {
  try {
    const shop = await integrationShop(request);
    await removeKlaviyoKey(shop.id);
    return NextResponse.json(await getKlaviyoStatus(shop.id), { headers: NO_STORE });
  } catch (error) {
    return failed(error);
  }
}

function failed(error: unknown) {
  const status = error instanceof ShopChoiceError ? 400 : 500;
  return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status, headers: NO_STORE });
}
