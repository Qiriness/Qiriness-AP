import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { deleteSalesChannel, updateSalesChannel } from "@/lib/server/sales-channels-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/** Changes a marketplace's name, handles or Analytics names. Its key never changes. */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({ salesChannels: await updateSalesChannel(await getShopId(), params.id, body ?? {}) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/** Removes it: its handles count as the shop's own store again. */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    return NextResponse.json({ salesChannels: await deleteSalesChannel(await getShopId(), params.id) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
