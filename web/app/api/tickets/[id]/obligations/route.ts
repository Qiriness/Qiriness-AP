import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { actOnObligation } from "@/lib/server/case-state-service";
import { getTicketListItem } from "@/lib/server/tickets-service";
import { getSession } from "@/lib/server/auth";
import { knowledgeErrorResponse, KnowledgeValidationError } from "@/lib/server/knowledge-errors";
import { ticketsChanged } from "@/lib/server/cache-tags";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * A person settles one open check: `fulfilled` (it was done, by phone, in
 * Shopify, by Deret) or `cancelled` (no longer needed).
 *
 * The only case-state write the dashboard has. It sends nothing and records the
 * user's id, not their name. The ticket is re-folded at once, which may move its
 * status (stage 5c: the last check a colleague owed, settled, takes it off
 * awaiting_human), so the queue row comes back with the new state.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json().catch(() => ({}));
    const obligationId = typeof body.obligationId === "string" ? body.obligationId : "";
    const action = typeof body.action === "string" ? body.action : "";
    if (!obligationId) {
      throw new KnowledgeValidationError("obligationId is required.");
    }

    const shopId = await getShopId();
    const session = await getSession();
    const caseState = await actOnObligation(shopId, params.id, obligationId, action, session?.sub ?? null);
    ticketsChanged();
    const ticket = await getTicketListItem(shopId, params.id);
    return NextResponse.json({ caseState, ticket });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
