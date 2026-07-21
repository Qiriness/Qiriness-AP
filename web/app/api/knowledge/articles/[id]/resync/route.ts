import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId, resyncArticle } from "@/lib/server/knowledge-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * Re-pulls the linked Shopify page or policy's live content. Only available
 * for articles still linked to a Shopify source (source_type !== "manual");
 * editing an article converts it to manual, at which point there's nothing
 * left to resync from and this returns 400.
 */
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const shopId = await getShopId();
    const article = await resyncArticle(shopId, params.id);
    return NextResponse.json({ article });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
