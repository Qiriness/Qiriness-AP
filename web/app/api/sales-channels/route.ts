import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { addSalesChannel, listSalesChannels } from "@/lib/server/sales-channels-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

/** The marketplaces, and every sales channel handle the orders carry. */
export async function GET() {
  try {
    return NextResponse.json({ salesChannels: await listSalesChannels(await getShopId()) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/** Adds a marketplace. Returns the whole view. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({ salesChannels: await addSalesChannel(await getShopId(), body ?? {}) });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
