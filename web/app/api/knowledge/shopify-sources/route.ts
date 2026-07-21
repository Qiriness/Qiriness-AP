import { NextResponse } from "next/server";
import { getShopId, listShopifySources } from "@/lib/server/knowledge-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

/** Lists the live Shopify page + policy catalog for the Agent Setup source dropdown. */
export async function GET() {
  try {
    const shopId = await getShopId();
    const sources = await listShopifySources(shopId);
    return NextResponse.json({ sources });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
