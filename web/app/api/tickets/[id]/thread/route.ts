import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getShopId } from "@/lib/server/knowledge-service";
import { getTicketThread } from "@/lib/server/tickets-service";
import { knowledgeErrorResponse } from "@/lib/server/knowledge-errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

/**
 * The full conversation on one ticket, for the thread dialog.
 *
 * A route of its own rather than a wider `GET /api/tickets/:id`: the bodies are
 * the heaviest thing on the table and the expanded row never shows them, so
 * they are fetched when somebody opens the dialog and not on every expansion.
 *
 * Read-only. Replying still happens in Outlook — this exists so reading a case
 * does not.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const shopId = await getShopId();
    const thread = await getTicketThread(shopId, params.id);
    return NextResponse.json({ thread });
  } catch (error) {
    return knowledgeErrorResponse(error);
  }
}
