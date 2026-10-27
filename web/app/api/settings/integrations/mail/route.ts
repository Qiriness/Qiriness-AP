import { NextResponse } from "next/server";
import { readMailSettings, saveMailSetting } from "../../../../../../scripts/lib/shop-mail-settings.mjs";
import { getSupabaseClient } from "@/lib/server/insights/shared";
import { ShopChoiceError, integrationShop } from "@/lib/server/integration-shop";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Who the automatic mail of the shop in `?shop=` (required: integration-shop.ts)
 * comes from and goes to: the monthly sales report and the stock alert
 * (scripts/lib/shop-mail-settings.mjs). GET both · PUT `{kind, sender,
 * recipients}` for one. Closed to the contact team, as the Klaviyo key is
 * (dashboard-auth.mjs).
 */
export async function GET(request: Request) {
  try {
    const shop = await integrationShop(request);
    return NextResponse.json(await readMailSettings(getSupabaseClient(), shop.id), { headers: NO_STORE });
  } catch (error) {
    return failed(error);
  }
}

export async function PUT(request: Request) {
  try {
    const shop = await integrationShop(request);
    const body = await request.json().catch(() => ({}));
    const result = (await saveMailSetting(getSupabaseClient(), shop.id, body?.kind, { sender: body?.sender, recipients: body?.recipients })) as
      | { ok: true; value: unknown }
      | { ok: false; error: string };
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400, headers: NO_STORE });
    return NextResponse.json(result.value, { headers: NO_STORE });
  } catch (error) {
    return failed(error);
  }
}

function failed(error: unknown) {
  const status = error instanceof ShopChoiceError ? 400 : 500;
  return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status, headers: NO_STORE });
}
