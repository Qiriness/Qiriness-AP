import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/server/auth";
import { getShopId } from "@/lib/server/knowledge-service";
import { changeTicketOrder, previewTicketOrder } from "@/lib/server/tickets-service";
import { logDashboardAccess } from "@/lib/server/access-log";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * The order a person is about to link to this ticket, as the popup previews it.
 *
 * Logged like every other read that shows a customer by name: the preview carries
 * the name on the order and its masked contact address.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const shopId = await getShopId();
    const preview = await previewTicketOrder(shopId, params.id, request.nextUrl.searchParams.get("number"));
    await logDashboardAccess({
      shopId,
      action: "view",
      resourceType: "orders",
      resourceId: params.id,
      purpose: "support_order_link",
    });
    return NextResponse.json({ preview });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}

/**
 * Add, change or confirm this ticket's order, and queue the investigation again.
 *
 * Open to every signed-in role: the contact team works these tickets. Who made
 * the change is recorded on the ticket (`metadata.order_resolution.set_by`).
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json().catch(() => ({}));
    const [shopId, session] = await Promise.all([getShopId(), getSession()]);
    const change = await changeTicketOrder(
      shopId,
      params.id,
      { number: body?.number, expected: body?.expected ?? null, source: body?.source },
      session?.sub ?? null
    );
    return NextResponse.json(change);
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
