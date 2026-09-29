import { NextResponse } from "next/server";
import { getShop } from "@/lib/server/shop";
import { getShopId } from "@/lib/server/knowledge-service";
import { getForwardingConfig } from "@/lib/server/forwarding-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

/** Every destination, the acknowledgement settings and the default templates. */
export async function GET() {
  try {
    const shopId = await getShopId();
    const shop = await getShop();
    return NextResponse.json(await getForwardingConfig(shopId, shop?.shopName ?? null));
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
