import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { formatArticleAsFaq, getShopId } from "@/lib/server/knowledge-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

/**
 * « Format as FAQ »: returns the given article content rearranged into the FAQ
 * shape. Stateless on purpose: it formats what is in the editor, saved or not,
 * and stores nothing — the team reviews the result and saves it themselves.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const shopId = await getShopId();
    const result = await formatArticleAsFaq(shopId, {
      title: typeof body.title === "string" ? body.title : "",
      content: typeof body.content === "string" ? body.content : "",
    });
    return NextResponse.json(result);
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
