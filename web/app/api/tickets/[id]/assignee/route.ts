import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/server/auth";
import { getShopId } from "@/lib/server/knowledge-service";
import { assignTicket } from "@/lib/server/tickets-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";
import { ticketsChanged } from "@/lib/server/cache-tags";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * A person assigns the ticket to a member of the team (`assigneeId`), or
 * unassigns it (`assigneeId: null`). Nothing else about the ticket changes.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json().catch(() => ({}));
    const assigneeId = typeof body.assigneeId === "string" && body.assigneeId ? body.assigneeId : null;
    const [shopId, session] = await Promise.all([getShopId(), getSession()]);
    // The user id, never a name or an address.
    const ticket = await assignTicket(shopId, params.id, assigneeId, session?.sub ?? null);
    ticketsChanged();
    return NextResponse.json({ ticket });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
