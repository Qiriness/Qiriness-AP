import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { listDroppedMailPage } from "@/lib/server/dropped-mail-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

/**
 * One page of the Irrelevant list: `?offset=` for « load more », `?q=` for a
 * search, which runs in the database because the page holds only what it loaded.
 */
export async function GET(request: NextRequest) {
  try {
    const shopId = await getShopId();
    const offset = Number(request.nextUrl.searchParams.get("offset") ?? 0) || 0;
    const query = request.nextUrl.searchParams.get("q") ?? "";
    return NextResponse.json(await listDroppedMailPage(shopId, { offset, query }));
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
