import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { retryForward } from "@/lib/server/manual-forward-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string; forwardId: string };
}

/** « Retry » on a forward that failed: back in the queue with a fresh draft. */
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const shopId = await getShopId();
    const forward = await retryForward(shopId, params.forwardId);
    return NextResponse.json({ forward });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
