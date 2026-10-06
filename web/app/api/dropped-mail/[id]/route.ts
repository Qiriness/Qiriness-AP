import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { getDroppedMail } from "@/lib/server/dropped-mail-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * One dropped email with its text and parcels, read when its dialog opens. The
 * Irrelevant list carries no text: every body on every /tickets load was 1.9 MB.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const shopId = await getShopId();
    return NextResponse.json(await getDroppedMail(shopId, params.id));
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
