import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { deleteSender, updateSender } from "@/lib/server/senders-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * Changes a row's label or note. A label is a fact about when mail ARRIVES:
 * messages already stored keep the actor they were given (`actors:backfill
 * -- --recompute` rewrites them, deliberately, from the command line).
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({ senders: await updateSender(await getShopId(), params.id, body ?? {}) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    return NextResponse.json({ senders: await deleteSender(await getShopId(), params.id) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
