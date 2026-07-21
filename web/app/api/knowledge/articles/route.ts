import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createArticle, getShopId, listArticles } from "@/lib/server/knowledge-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

/** Lists every knowledge article for the shop. */
export async function GET() {
  try {
    const shopId = await getShopId();
    const articles = await listArticles(shopId);
    return NextResponse.json({ articles });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/**
 * Creates an article. With `sourceId` (a shopify_content_sources.id), imports
 * live content from that Shopify page or policy (fills content immediately).
 * Without it, creates an empty standalone article.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const shopId = await getShopId();
    const article = await createArticle(shopId, {
      title: typeof body.title === "string" ? body.title : undefined,
      category: typeof body.category === "string" ? body.category : undefined,
      coreTopic: typeof body.coreTopic === "string" ? body.coreTopic : null,
      sourceId: typeof body.sourceId === "string" ? body.sourceId : null,
    });
    return NextResponse.json({ article }, { status: 201 });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
